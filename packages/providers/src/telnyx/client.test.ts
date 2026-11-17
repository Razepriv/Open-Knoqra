import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TelnyxProvider } from './client';
import { TelnyxApiError } from './errors';

const API_KEY = 'KEY_test_secret_value';
const BASE = 'https://api.telnyx.com/v2';
const NOW = Date.parse('2026-11-11T10:00:00Z');

type Call = { url: string; method: string; headers: Headers; body: unknown };
type Route = { method: string; url: string; respond: () => Response };

/** An injected fetch that only answers declared routes. Any other URL throws, so no test can reach the network. */
function stubFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const route = routes.find((r) => r.url === url && r.method === method);
    if (!route) throw new Error(`unexpected network call: ${method} ${url}`);
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return route.respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function provider(fetchImpl: typeof fetch, extra: { telephonyCredentialId?: string } = {}) {
  return new TelnyxProvider({
    apiKey: API_KEY,
    connectionId: 'conn-1',
    fetch: fetchImpl,
    now: () => NOW,
    ...extra,
  });
}

describe('TelnyxProvider.createClientSession', () => {
  it('creates a credential when absent, then returns the token text', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials`,
        respond: json(200, { data: { id: 'cred-1' } }),
      },
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials/cred-1/token`,
        respond: () => new Response('jwt.token.text', { status: 200 }),
      },
    ]);
    const p = provider(fetchImpl);
    const session = await p.createClientSession({ orgId: 'org_abc', userId: 'usr_1' });
    expect(session).toEqual({
      token: 'jwt.token.text',
      expiresAt: new Date(NOW + 24 * 3600 * 1000).toISOString(),
    });
    expect(p.lastTelephonyCredentialId).toBe('cred-1');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual({ connection_id: 'conn-1', name: 'knoqra-org_abc' });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(calls[1]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('reuses a known credential without creating one', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials/cred-9/token`,
        respond: () => new Response('tok', { status: 200 }),
      },
    ]);
    const p = provider(fetchImpl, { telephonyCredentialId: 'cred-9' });
    await p.createClientSession({ orgId: 'org_abc', userId: 'usr_1' });
    expect(calls).toHaveLength(1);
    expect(p.lastTelephonyCredentialId).toBe('cred-9');
  });
});

describe('TelnyxProvider calls', () => {
  it('creates an outbound call with base64 client_state', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/calls`,
        respond: json(200, { data: { call_control_id: 'v3:abc' } }),
      },
    ]);
    const result = await provider(fetchImpl).createCall({
      orgId: 'org_abc',
      from: '+12025550101',
      to: '+12025550123',
      idempotencyKey: 'idem_key_1',
    });
    expect(result).toEqual({ providerCallId: 'v3:abc', state: 'queued' });
    expect(calls[0]?.body).toEqual({
      connection_id: 'conn-1',
      to: '+12025550123',
      from: '+12025550101',
      client_state: 'aWRlbV9rZXlfMQ==',
    });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('sets the leg time limit, clamped to Telnyx range', async () => {
    const { calls, fetchImpl } = stubFetch(
      [600, 5, 99_999].map(() => ({
        method: 'POST',
        url: `${BASE}/calls`,
        respond: json(200, { data: { call_control_id: 'v3:abc' } }),
      })),
    );
    for (const timeLimitSecs of [600, 5, 99_999]) {
      await provider(fetchImpl).createCall({
        orgId: 'org_abc',
        from: '+12025550101',
        to: '+12025550123',
        idempotencyKey: 'idem_key_1',
        timeLimitSecs,
      });
    }
    expect(calls.map((c) => (c.body as { time_limit_secs?: number }).time_limit_secs)).toEqual([
      600, 30, 14_400,
    ]);
  });

  it('hangs up by call control id', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/calls/v3%3Aabc/actions/hangup`,
        respond: json(200, { data: { result: 'ok' } }),
      },
    ]);
    await provider(fetchImpl).endCall('v3:abc');
    expect(calls).toHaveLength(1);
  });
});

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/telnyx/${name}.json`, import.meta.url), 'utf8'),
  );
const fixtureResponse = (name: string) => json(200, fixture(name));

const NUMBERS_1 = `${BASE}/phone_numbers?page%5Bnumber%5D=1&page%5Bsize%5D=250`;
const NUMBERS_2 = `${BASE}/phone_numbers?page%5Bnumber%5D=2&page%5Bsize%5D=250`;
const CAMPAIGNS = `${BASE}/10dlc/phone_number_campaigns?page%5Bsize%5D=250`;

const WA_NUMBERS = `${BASE}/whatsapp/phone_numbers?page%5Bnumber%5D=1&page%5Bsize%5D=250`;
const WA_ACCOUNTS = `${BASE}/whatsapp/business_accounts?page%5Bnumber%5D=1&page%5Bsize%5D=250`;
const NO_WHATSAPP = { data: [], meta: { page_number: 1, total_pages: 0 } };

const numberRoutes = (): Route[] => [
  { method: 'GET', url: NUMBERS_1, respond: fixtureResponse('phone-numbers-page-1') },
  { method: 'GET', url: NUMBERS_2, respond: fixtureResponse('phone-numbers-page-2') },
  { method: 'GET', url: CAMPAIGNS, respond: fixtureResponse('phone-number-campaigns') },
  { method: 'GET', url: WA_NUMBERS, respond: json(200, NO_WHATSAPP) },
];

describe('TelnyxProvider.fetchBalance', () => {
  it('maps the decimal balance to micros with the bearer header', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'GET', url: `${BASE}/balance`, respond: fixtureResponse('balance') },
    ]);
    expect(await provider(fetchImpl).fetchBalance()).toEqual({
      balanceMicros: 300_000_000,
      currency: 'USD',
    });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('rejects an unparsable balance and a non-USD currency as invalid_response', async () => {
    for (const data of [
      { balance: 'abc', currency: 'USD' },
      { balance: '1.00', currency: 'EUR' },
    ]) {
      const { fetchImpl } = stubFetch([
        { method: 'GET', url: `${BASE}/balance`, respond: json(200, { data }) },
      ]);
      await expect(provider(fetchImpl).fetchBalance()).rejects.toMatchObject({
        name: 'TelnyxApiError',
        code: 'invalid_response',
      });
    }
  });

  it('hides the key and the body on a 401', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: `${BASE}/balance`,
        respond: json(401, { errors: [{ code: '10009', detail: `bad ${API_KEY}` }] }),
      },
    ]);
    const error = await provider(fetchImpl)
      .fetchBalance()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    expect((error as TelnyxApiError).status).toBe(401);
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).not.toContain('bad');
  });
});

describe('TelnyxProvider.listNumbers', () => {
  it('concatenates pages and maps capabilities, status and 10DLC state', async () => {
    const { calls, fetchImpl } = stubFetch(numberRoutes());
    const numbers = await provider(fetchImpl).listNumbers();
    expect(calls.map((c) => c.url)).toEqual([NUMBERS_1, NUMBERS_2, CAMPAIGNS, WA_NUMBERS]);
    expect(calls.every((c) => c.headers.get('authorization') === `Bearer ${API_KEY}`)).toBe(true);
    expect(numbers).toEqual([
      {
        providerNumberId: 'pn-fixture-0100',
        e164: '+12025550100',
        status: 'active',
        capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
        tenDlc: 'registered',
        whatsapp: 'none',
      },
      {
        providerNumberId: 'pn-fixture-0101',
        e164: '+12025550101',
        status: 'active',
        capabilities: { voice: true, sms: false, mms: false, whatsapp: false },
        tenDlc: 'not_required',
        whatsapp: 'none',
      },
      {
        providerNumberId: 'pn-fixture-0102',
        e164: '+12025550102',
        status: 'pending',
        capabilities: { voice: false, sms: true, mms: true, whatsapp: false },
        tenDlc: 'pending',
        whatsapp: 'none',
      },
      {
        providerNumberId: 'pn-fixture-0103',
        e164: '+12025550103',
        status: 'inactive',
        capabilities: { voice: false, sms: true, mms: true, whatsapp: false },
        tenDlc: 'failed',
        whatsapp: 'none',
      },
    ]);
  });

  it('marks an SMS number with no campaign as none', async () => {
    const page = {
      data: [
        {
          id: 'pn-x',
          phone_number: '+12025550104',
          status: 'port-pending',
          connection_id: null,
          messaging_profile_id: 'mp',
        },
      ],
      meta: { total_pages: 1, page_number: 1 },
    };
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: NUMBERS_1, respond: json(200, page) },
      { method: 'GET', url: CAMPAIGNS, respond: json(200, { records: [] }) },
    ]);
    const [n] = await provider(fetchImpl).listNumbers();
    expect(n).toMatchObject({ status: 'pending', tenDlc: 'none' });
  });

  it('hides the key on a 401 from the campaigns read', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: NUMBERS_1, respond: fixtureResponse('phone-numbers-page-1') },
      { method: 'GET', url: NUMBERS_2, respond: fixtureResponse('phone-numbers-page-2') },
      { method: 'GET', url: CAMPAIGNS, respond: json(401, { errors: [{ code: '10009' }] }) },
    ]);
    const error = await provider(fetchImpl)
      .listNumbers()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    expect((error as Error).message).not.toContain(API_KEY);
  });
});

describe('TelnyxProvider.listNumbers WhatsApp facts', () => {
  const routesWith = (wa: Route[]): Route[] => [...numberRoutes().slice(0, 3), ...wa];

  it('marks a CONNECTED number on an APPROVED account as an approved WhatsApp number', async () => {
    const { fetchImpl } = stubFetch(
      routesWith([
        { method: 'GET', url: WA_NUMBERS, respond: fixtureResponse('whatsapp-phone-numbers') },
        { method: 'GET', url: WA_ACCOUNTS, respond: fixtureResponse('whatsapp-business-accounts') },
      ]),
    );
    const numbers = await provider(fetchImpl).listNumbers();
    expect(numbers[0]).toMatchObject({
      e164: '+12025550100',
      capabilities: { whatsapp: true },
      whatsapp: 'approved',
      whatsappDetail: { displayName: 'Example Repairs', qualityRating: 'GREEN' },
    });
    expect(numbers[1]).toMatchObject({
      e164: '+12025550101',
      capabilities: { whatsapp: true },
      whatsapp: 'pending',
    });
    expect(numbers[2]).toMatchObject({ capabilities: { whatsapp: false }, whatsapp: 'none' });
    expect(numbers.every((n) => n.whatsappSynced === undefined)).toBe(true);
  });

  it('reads a 404 (no WhatsApp product) as no WhatsApp numbers', async () => {
    const { fetchImpl } = stubFetch(
      routesWith([
        { method: 'GET', url: WA_NUMBERS, respond: json(404, { errors: [{ code: '10005' }] }) },
      ]),
    );
    const numbers = await provider(fetchImpl).listNumbers();
    expect(numbers.every((n) => n.whatsapp === 'none' && n.whatsappSynced === undefined)).toBe(
      true,
    );
  });

  it('keeps what it knew when a restricted key may not read WhatsApp (403)', async () => {
    const { fetchImpl } = stubFetch(
      routesWith([
        { method: 'GET', url: WA_NUMBERS, respond: json(403, { errors: [{ code: '10010' }] }) },
      ]),
    );
    const numbers = await provider(fetchImpl).listNumbers();
    expect(numbers.every((n) => n.whatsappSynced === false)).toBe(true);
  });

  it('marks the WhatsApp facts unread on an outage, so the sync keeps what it knew', async () => {
    const { fetchImpl } = stubFetch(
      routesWith([
        { method: 'GET', url: WA_NUMBERS, respond: json(503, { errors: [{ code: 'x' }] }) },
      ]),
    );
    const numbers = await provider(fetchImpl).listNumbers();
    expect(numbers.every((n) => n.whatsappSynced === false)).toBe(true);
  });
});

describe('TelnyxProvider.fetchUsage', () => {
  const from = '2026-11-11T00:00:00Z';
  const to = '2026-11-12T00:00:00Z';
  const url = (page: number) =>
    `${BASE}/detail_records?filter%5Brecord_type%5D=call-control&filter%5Bstarted_at%5D%5Bgte%5D=2026-11-11T00%3A00%3A00Z&filter%5Bstarted_at%5D%5Blt%5D=2026-11-12T00%3A00%3A00Z&page%5Bnumber%5D=${page}&page%5Bsize%5D=250`;

  it('maps detail records exactly, including providerRef', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'GET', url: url(1), respond: fixtureResponse('detail-records') },
    ]);
    expect(await provider(fetchImpl).fetchUsage({ from, to })).toEqual([
      {
        service: 'voice',
        quantity: 60,
        unit: 'second',
        costMicros: 12_000,
        occurredAt: '2026-11-11T10:00:00Z',
        providerRef: 'dr-fixture-1',
      },
      {
        service: 'voice',
        quantity: 125,
        unit: 'second',
        costMicros: 25_000,
        occurredAt: '2026-11-11T11:30:00Z',
        providerRef: 'dr-fixture-2',
      },
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('follows pages until total_pages', async () => {
    const rec = (id: string) => ({
      id,
      started_at: '2026-11-11T10:00:00Z',
      billed_sec: 6,
      cost: '0.001',
      currency: 'USD',
    });
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: url(1),
        respond: json(200, { data: [rec('a')], meta: { total_pages: 2, page_number: 1 } }),
      },
      {
        method: 'GET',
        url: url(2),
        respond: json(200, { data: [rec('b')], meta: { total_pages: 2, page_number: 2 } }),
      },
    ]);
    const usage = await provider(fetchImpl).fetchUsage({ from, to });
    expect(usage.map((u) => u.providerRef)).toEqual(['a', 'b']);
  });

  it('rejects a non-USD record as invalid_response', async () => {
    const bad = {
      data: [
        { id: 'a', started_at: '2026-11-11T10:00:00Z', billed_sec: 6, cost: '1', currency: 'EUR' },
      ],
      meta: { total_pages: 1, page_number: 1 },
    };
    const { fetchImpl } = stubFetch([{ method: 'GET', url: url(1), respond: json(200, bad) }]);
    await expect(provider(fetchImpl).fetchUsage({ from, to })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('rejects a negative record cost as invalid_response', async () => {
    const bad = {
      data: [
        {
          id: 'a',
          started_at: '2026-11-11T10:00:00Z',
          billed_sec: 6,
          cost: '-0.01',
          currency: 'USD',
        },
      ],
      meta: { total_pages: 1, page_number: 1 },
    };
    const { fetchImpl } = stubFetch([{ method: 'GET', url: url(1), respond: json(200, bad) }]);
    await expect(provider(fetchImpl).fetchUsage({ from, to })).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    });
  });

  it('hides the key on a 401', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: url(1), respond: json(401, { errors: [{ code: '10009' }] }) },
    ]);
    const error = await provider(fetchImpl)
      .fetchUsage({ from, to })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    expect((error as Error).message).not.toContain(API_KEY);
  });
});

describe('TelnyxProvider hardening', () => {
  it('keeps the api key out of enumerable state', () => {
    const p = provider(stubFetch([]).fetchImpl);
    expect(JSON.stringify(p)).not.toContain(API_KEY);
    expect(JSON.stringify(Object.values(p))).not.toContain(API_KEY);
    expect(Object.keys(p)).not.toContain('apiKey');
  });

  it('throws invalid_response for a 2xx body that is not the expected JSON', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/calls`,
        respond: () => new Response('<html>secret-snippet</html>', { status: 200 }),
      },
    ]);
    const e = (await provider(fetchImpl)
      .createCall({ orgId: 'o', from: '+12025550101', to: '+12025550123', idempotencyKey: 'k' })
      .catch((x: unknown) => x)) as TelnyxApiError;
    expect(e).toBeInstanceOf(TelnyxApiError);
    expect(e.status).toBe(200);
    expect(e.code).toBe('invalid_response');
    expect(e.message).not.toContain('secret-snippet');
  });

  it('throws invalid_response for a credential response missing its id', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials`,
        respond: json(200, { data: {} }),
      },
    ]);
    const e = (await provider(fetchImpl)
      .createClientSession({ orgId: 'o', userId: 'u' })
      .catch((x: unknown) => x)) as TelnyxApiError;
    expect(e).toBeInstanceOf(TelnyxApiError);
    expect(e.code).toBe('invalid_response');
  });

  it('throws invalid_response for an empty token', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials/cred-9/token`,
        respond: () => new Response('  ', { status: 200 }),
      },
    ]);
    const e = (await provider(fetchImpl, { telephonyCredentialId: 'cred-9' })
      .createClientSession({ orgId: 'o', userId: 'u' })
      .catch((x: unknown) => x)) as TelnyxApiError;
    expect(e).toBeInstanceOf(TelnyxApiError);
    expect(e.status).toBe(200);
    expect(e.code).toBe('invalid_response');
  });

  it('treats an empty-string telephonyCredentialId as absent', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials`,
        respond: json(200, { data: { id: 'cred-2' } }),
      },
      {
        method: 'POST',
        url: `${BASE}/telephony_credentials/cred-2/token`,
        respond: () => new Response('tok', { status: 200 }),
      },
    ]);
    const p = provider(fetchImpl, { telephonyCredentialId: '' });
    await p.createClientSession({ orgId: 'o', userId: 'u' });
    expect(calls).toHaveLength(2);
    expect(p.lastTelephonyCredentialId).toBe('cred-2');
  });
});

describe('TelnyxProvider errors', () => {
  it('throws TelnyxApiError with status and code only', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/calls`,
        respond: json(401, {
          errors: [{ code: '10009', title: 'Authentication failed', detail: `bad ${API_KEY}` }],
        }),
      },
    ]);
    const error = await provider(fetchImpl)
      .createCall({ orgId: 'o', from: '+12025550101', to: '+12025550123', idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    const e = error as TelnyxApiError;
    expect(e.status).toBe(401);
    expect(e.code).toBe('10009');
    expect(e.message).not.toContain(API_KEY);
    expect(e.message).not.toContain('Authentication failed');
    expect(e.message).toContain('401');
    expect(e.message).toContain('10009');
  });

  it('uses an unknown code when the body is not JSON', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/calls/v3%3Aabc/actions/hangup`,
        respond: () => new Response(`<html>${API_KEY}</html>`, { status: 502 }),
      },
    ]);
    const e = (await provider(fetchImpl)
      .endCall('v3:abc')
      .catch((x: unknown) => x)) as TelnyxApiError;
    expect(e).toBeInstanceOf(TelnyxApiError);
    expect(e.code).toBe('unknown');
    expect(e.message).not.toContain(API_KEY);
  });

  it('never touches the network: an unexpected URL throws from the stub', async () => {
    const { fetchImpl } = stubFetch([]);
    await expect(
      provider(fetchImpl).createCall({
        orgId: 'o',
        from: '+12025550101',
        to: '+12025550123',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow('unexpected network call');
  });
});

describe('TelnyxProvider paging guards', () => {
  const never = (data: unknown[]) =>
    json(200, { data, meta: { total_pages: 999, page_number: 1 } });
  const rec = {
    id: 'a',
    started_at: '2026-11-11T10:00:00Z',
    billed_sec: 6,
    cost: '0.001',
    currency: 'USD',
  };
  const num = {
    id: 'pn-x',
    phone_number: '+12025550104',
    status: 'active',
    connection_id: 'c',
    messaging_profile_id: null,
  };
  const usageUrl = (page: number) =>
    `${BASE}/detail_records?filter%5Brecord_type%5D=call-control&filter%5Bstarted_at%5D%5Bgte%5D=f&filter%5Bstarted_at%5D%5Blt%5D=t&page%5Bnumber%5D=${page}&page%5Bsize%5D=250`;
  const numUrl = (page: number) =>
    `${BASE}/phone_numbers?page%5Bnumber%5D=${page}&page%5Bsize%5D=250`;
  const capped = (fetchImpl: typeof fetch) =>
    new TelnyxProvider({ apiKey: API_KEY, connectionId: 'c', fetch: fetchImpl, maxPages: 2 });

  it('fails instead of returning partial numbers at the page cap', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: numUrl(1), respond: never([num]) },
      { method: 'GET', url: numUrl(2), respond: never([num]) },
    ]);
    await expect(capped(fetchImpl).listNumbers()).rejects.toMatchObject({
      name: 'TelnyxApiError',
      code: 'invalid_response',
    });
  });

  it('fails instead of returning partial usage at the page cap', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: usageUrl(1), respond: never([rec]) },
      { method: 'GET', url: usageUrl(2), respond: never([rec]) },
    ]);
    await expect(capped(fetchImpl).fetchUsage({ from: 'f', to: 't' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('fails on an empty page while more pages are promised', async () => {
    const { calls, fetchImpl } = stubFetch([{ method: 'GET', url: numUrl(1), respond: never([]) }]);
    await expect(provider(fetchImpl).listNumbers()).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(calls).toHaveLength(1);
    const usage = stubFetch([{ method: 'GET', url: usageUrl(1), respond: never([]) }]);
    await expect(
      provider(usage.fetchImpl).fetchUsage({ from: 'f', to: 't' }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(usage.calls).toHaveLength(1);
  });
});

const qs = (pairs: [string, string][]) => new URLSearchParams(pairs).toString();

const SEARCH_URL = `${BASE}/available_phone_numbers?${qs([
  ['filter[country_code]', 'US'],
  ['filter[national_destination_code]', '202'],
  ['filter[locality]', 'Washington'],
  ['filter[administrative_area]', 'DC'],
  ['filter[features][]', 'voice'],
  ['filter[features][]', 'sms'],
  ['filter[limit]', '20'],
])}`;
const QUOTE_URL = `${BASE}/available_phone_numbers?${qs([
  ['filter[country_code]', 'US'],
  ['filter[phone_number][contains]', '2025550150'],
  ['filter[limit]', '10'],
])}`;

const searchRow = (phone: string, cost: Record<string, string>) => ({
  phone_number: phone,
  region_information: [],
  cost_information: cost,
  features: [],
});
const USD_COST = { upfront_cost: '1.00', monthly_cost: '1.00', currency: 'USD' };

describe('TelnyxProvider number purchase', () => {
  it('searches with encoded filters and maps cost, region and features', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'GET', url: SEARCH_URL, respond: fixtureResponse('available-phone-numbers') },
    ]);
    const found = await provider(fetchImpl).searchAvailableNumbers({
      country: 'US',
      areaCode: '202',
      locality: 'Washington',
      region: 'DC',
      features: ['voice', 'sms'],
    });
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(found).toEqual([
      {
        e164: '+12025550150',
        locality: 'WASHINGTON',
        region: 'DC',
        capabilities: { voice: true, sms: true, mms: true },
        upfrontMicros: 1_000_000,
        monthlyMicros: 1_000_000,
        currency: 'USD',
      },
      {
        e164: '+12025550151',
        locality: null,
        region: 'DC',
        capabilities: { voice: true, sms: false, mms: false },
        upfrontMicros: 500_000,
        monthlyMicros: 1_250_000,
        currency: 'USD',
      },
    ]);
  });

  it('omits unset filters and caps the limit at 20', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: `${BASE}/available_phone_numbers?${qs([
          ['filter[country_code]', 'US'],
          ['filter[features][]', 'mms'],
          ['filter[limit]', '5'],
        ])}`,
        respond: json(200, { data: [] }),
      },
      {
        method: 'GET',
        url: `${BASE}/available_phone_numbers?${qs([
          ['filter[country_code]', 'US'],
          ['filter[limit]', '20'],
        ])}`,
        respond: json(200, { data: [] }),
      },
    ]);
    const p = provider(fetchImpl);
    expect(await p.searchAvailableNumbers({ country: 'US', features: ['mms'], limit: 5 })).toEqual(
      [],
    );
    expect(await p.searchAvailableNumbers({ country: 'US', features: [], limit: 99 })).toEqual([]);
  });

  it('rejects a non-USD or unparsable cost as invalid_response', async () => {
    for (const cost of [
      { upfront_cost: '1.00', monthly_cost: '1.00', currency: 'CAD' },
      { upfront_cost: 'abc', monthly_cost: '1.00', currency: 'USD' },
      { upfront_cost: '1.00', monthly_cost: '-1.00', currency: 'USD' },
    ]) {
      const { fetchImpl } = stubFetch([
        {
          method: 'GET',
          url: QUOTE_URL,
          respond: json(200, { data: [searchRow('+12025550150', cost)] }),
        },
      ]);
      await expect(provider(fetchImpl).quoteNumber('+12025550150')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });

  it('quotes an exact match and answers null on a miss or a different number', async () => {
    const hitStub = stubFetch([
      { method: 'GET', url: QUOTE_URL, respond: fixtureResponse('available-phone-numbers') },
    ]);
    const hit = await provider(hitStub.fetchImpl).quoteNumber('+12025550150');
    expect(hit?.e164).toBe('+12025550150');
    expect(hit?.monthlyMicros).toBe(1_000_000);

    const miss = stubFetch([{ method: 'GET', url: QUOTE_URL, respond: json(200, { data: [] }) }]);
    expect(await provider(miss.fetchImpl).quoteNumber('+12025550150')).toBeNull();

    const other = stubFetch([
      {
        method: 'GET',
        url: QUOTE_URL,
        respond: json(200, { data: [searchRow('+12025559999', USD_COST)] }),
      },
    ]);
    expect(await provider(other.fetchImpl).quoteNumber('+12025550150')).toBeNull();
  });

  it('finds the exact number when it is the second of several contains matches', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: QUOTE_URL,
        respond: json(200, {
          data: [searchRow('+12125550150', USD_COST), searchRow('+12025550150', USD_COST)],
        }),
      },
    ]);
    expect((await provider(fetchImpl).quoteNumber('+12025550150'))?.e164).toBe('+12025550150');
  });

  it('rejects an invalid number or search before any network call', async () => {
    const { fetchImpl } = stubFetch([]);
    const p = provider(fetchImpl);
    for (const bad of ['+4420', '+11025550150', '2025550150', '+1202555015x', '+120255501500']) {
      await expect(p.quoteNumber(bad)).rejects.toThrow(new RangeError('invalid_number'));
      await expect(p.orderNumber({ e164: bad, connectionId: null })).rejects.toThrow(
        new RangeError('invalid_number'),
      );
    }
    for (const q of [
      { areaCode: '102' },
      { areaCode: '20' },
      { areaCode: '2a2' },
      { region: 'dc' },
      { region: 'DCX' },
      { locality: '' },
      { locality: '  Reno' },
      { locality: 'a'.repeat(61) },
      { locality: 'Re\nno' },
      { locality: 'Re&filter[limit]=\u0000' },
    ]) {
      await expect(p.searchAvailableNumbers({ country: 'US', features: [], ...q })).rejects.toThrow(
        new RangeError('invalid_search'),
      );
    }
  });

  it('clamps the limit to an integer between 1 and 20', async () => {
    const urlFor = (limit: string) =>
      `${BASE}/available_phone_numbers?${qs([
        ['filter[country_code]', 'US'],
        ['filter[limit]', limit],
      ])}`;
    const cases: [number, string][] = [
      [0, '1'],
      [-5, '1'],
      [2.9, '2'],
      [Number.NaN, '20'],
      [Number.POSITIVE_INFINITY, '20'],
    ];
    const { calls, fetchImpl } = stubFetch(
      cases.map(([, l]) => ({
        method: 'GET',
        url: urlFor(l),
        respond: json(200, { data: [] }),
      })),
    );
    for (const [limit] of cases) {
      await provider(fetchImpl).searchAvailableNumbers({ country: 'US', features: [], limit });
    }
    expect(calls.map((c) => c.url)).toEqual(cases.map(([, l]) => urlFor(l)));
  });

  it('orders with the connection id and maps a pending order', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/number_orders`,
        respond: fixtureResponse('number-order-created'),
      },
    ]);
    const res = await provider(fetchImpl).orderNumber({
      e164: '+12025550150',
      connectionId: 'conn-1',
    });
    expect(calls[0]?.body).toEqual({
      phone_numbers: [{ phone_number: '+12025550150' }],
      connection_id: 'conn-1',
    });
    expect(res).toEqual({
      providerOrderId: '12ade33a-21c0-473b-b055-b3c836e1c292',
      status: 'pending',
      e164: '+12025550150',
    });
  });

  it('attaches a messaging profile and a customer reference when given', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/number_orders`,
        respond: fixtureResponse('number-order-created'),
      },
    ]);
    await provider(fetchImpl).orderNumber({
      e164: '+12025550150',
      connectionId: 'conn-1',
      messagingProfileId: 'mp-1',
      customerReference: 'knoqra:org_1',
    });
    expect(calls[0]?.body).toEqual({
      phone_numbers: [{ phone_number: '+12025550150' }],
      connection_id: 'conn-1',
      messaging_profile_id: 'mp-1',
      customer_reference: 'knoqra:org_1',
    });
  });

  it('quotes a Canadian number in Canada', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: `${BASE}/available_phone_numbers?filter%5Bcountry_code%5D=CA&filter%5Bphone_number%5D%5Bcontains%5D=4165550150&filter%5Blimit%5D=10`,
        respond: json(200, { data: [] }),
      },
    ]);
    expect(await provider(fetchImpl).quoteNumber('+14165550150', 'CA')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('omits connection_id when null and maps success and failure statuses', async () => {
    for (const [status, mapped] of [
      ['success', 'completed'],
      ['failure', 'failed'],
      ['pending', 'pending'],
    ] as const) {
      const { calls, fetchImpl } = stubFetch([
        {
          method: 'POST',
          url: `${BASE}/number_orders`,
          respond: json(200, {
            data: { id: 'ord-1', status, phone_numbers: [{ phone_number: '+12025550150' }] },
          }),
        },
      ]);
      const res = await provider(fetchImpl).orderNumber({
        e164: '+12025550150',
        connectionId: null,
      });
      expect(res.status).toBe(mapped);
      expect(calls[0]?.body).toEqual({ phone_numbers: [{ phone_number: '+12025550150' }] });
    }
  });

  it('turns a 401 into a TelnyxApiError that leaks neither key nor body', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: SEARCH_URL,
        respond: json(401, { errors: [{ code: 10009, detail: `bad key ${API_KEY}` }] }),
      },
    ]);
    const failure = await provider(fetchImpl)
      .searchAvailableNumbers({
        country: 'US',
        areaCode: '202',
        locality: 'Washington',
        region: 'DC',
        features: ['voice', 'sms'],
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TelnyxApiError);
    expect((failure as TelnyxApiError).status).toBe(401);
    expect((failure as TelnyxApiError).code).toBe('10009');
    expect((failure as Error).message).not.toContain(API_KEY);
    expect((failure as Error).message).not.toContain('bad key');
  });

  it('maps an order rejection to TelnyxApiError', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${BASE}/number_orders`,
        respond: json(422, { errors: [{ code: 'bad number' }] }),
      },
    ]);
    await expect(
      provider(fetchImpl).orderNumber({ e164: '+12025550150', connectionId: null }),
    ).rejects.toMatchObject({ status: 422, code: 'unknown' });
  });
});

describe('releasing a number', () => {
  const url = `${BASE}/phone_numbers/1293384261075731499`;

  it('deletes the number and reports it released', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'DELETE',
        url,
        respond: json(200, { data: { id: '1293384261075731499', status: 'deleted' } }),
      },
    ]);
    await expect(provider(fetchImpl).releaseNumber('1293384261075731499')).resolves.toBe(
      'released',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('reads a 404 as a number Telnyx no longer has, not as an error', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'DELETE', url, respond: json(404, { errors: [{ code: '10005' }] }) },
    ]);
    await expect(provider(fetchImpl).releaseNumber('1293384261075731499')).resolves.toBe(
      'not_found',
    );
  });

  it('throws the status and code of any other refusal', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'DELETE', url, respond: json(422, { errors: [{ code: '10015' }] }) },
    ]);
    const error = await provider(fetchImpl)
      .releaseNumber('1293384261075731499')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelnyxApiError);
    expect(error).toMatchObject({ status: 422, code: '10015' });
  });

  it('refuses an id that is not a Telnyx id without calling Telnyx', async () => {
    const { calls, fetchImpl } = stubFetch([]);
    await expect(provider(fetchImpl).releaseNumber('../balance')).rejects.toBeInstanceOf(
      TelnyxApiError,
    );
    expect(calls).toHaveLength(0);
  });
});

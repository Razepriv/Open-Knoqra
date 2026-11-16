import { describe, expect, it } from 'vitest';
import { ProviderApiError } from '../provider-error';
import { PlivoProvider, parsePlivoTime } from './client';
import { PlivoApiError } from './errors';
import {
  ACCOUNT,
  AUTH_ID,
  AUTH_TOKEN,
  fixtureText,
  json,
  type Route,
  stubFetch,
} from './test-fetch.test-helpers';

const NOW = Date.parse('2026-11-11T10:00:00Z');

function provider(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof PlivoProvider>[0]> = {},
) {
  return new PlivoProvider({
    authId: AUTH_ID,
    authToken: AUTH_TOKEN,
    appId: 'app-fixture-1',
    fetch: fetchImpl,
    now: () => NOW,
    ...extra,
  });
}

const BASIC = `Basic ${btoa(`${AUTH_ID}:${AUTH_TOKEN}`)}`;
const page = (path: string, offset: number, filters = '') =>
  `${ACCOUNT}${path}?${filters}limit=20&offset=${offset}`;

describe('PlivoProvider.createClientSession', () => {
  it('creates the endpoint once, then asks Plivo for a 24-hour access token', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${ACCOUNT}/Endpoint/`,
        respond: json(201, fixtureText('endpoint-created')),
      },
      {
        method: 'POST',
        url: `${ACCOUNT}/JWT/Token/`,
        respond: json(200, fixtureText('jwt-token')),
      },
    ]);
    const p = provider(fetchImpl);
    const session = await p.createClientSession({ orgId: 'org_abc', userId: 'u_1' });
    expect(session.token).toMatch(/^eyJ/);
    expect(session.expiresAt).toBe(new Date(NOW + 24 * 3600 * 1000).toISOString());
    expect(p.lastEndpointUsername).toBe('knoqrafixture0000123456789012');
    const [endpoint, token] = calls;
    expect(endpoint?.headers.get('authorization')).toBe(BASIC);
    expect(endpoint?.body).toMatchObject({ alias: 'knoqra-org_abc', app_id: 'app-fixture-1' });
    expect(endpoint?.body).toMatchObject({
      username: expect.stringMatching(/^knoqra[a-z0-9]{10}$/),
      password: expect.stringMatching(/^[a-z0-9]{24}$/),
    });
    expect(token?.body).toEqual({
      iss: AUTH_ID,
      sub: 'knoqrafixture0000123456789012',
      nbf: NOW / 1000,
      exp: NOW / 1000 + 86_400,
      per: { voice: { incoming_allow: true, outgoing_allow: true } },
      app: 'app-fixture-1',
    });
  });

  it('reuses a known endpoint', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${ACCOUNT}/JWT/Token/`,
        respond: json(200, fixtureText('jwt-token')),
      },
    ]);
    await provider(fetchImpl, { endpointUsername: 'known-endpoint' }).createClientSession({
      orgId: 'org_abc',
      userId: 'u_1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ sub: 'known-endpoint' });
  });

  it('throws a typed error without Plivo text when the token is refused', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${ACCOUNT}/JWT/Token/`,
        respond: json(401, { api_id: 'x', error: `bad credentials for ${AUTH_TOKEN}` }),
      },
    ]);
    const error = await provider(fetchImpl, { endpointUsername: 'e' })
      .createClientSession({ orgId: 'o', userId: 'u' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlivoApiError);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect((error as PlivoApiError).status).toBe(401);
    expect(String((error as Error).message)).not.toContain(AUTH_TOKEN);
  });
});

describe('PlivoProvider calls', () => {
  it('places a server call with the client state as a SIP header', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'POST', url: `${ACCOUNT}/Call/`, respond: json(201, fixtureText('call-created')) },
    ]);
    const call = await provider(fetchImpl, {
      answerUrl: 'https://api.example/webhooks/plivo/org_1/answer',
      hangupUrl: 'https://api.example/webhooks/plivo/org_1',
    }).createCall({
      orgId: 'org_1',
      from: '+12025550110',
      to: '+12025550123',
      idempotencyKey: 'abc',
    });
    expect(call).toEqual({
      providerCallId: 'bbbbbbbb-0000-4000-8000-000000000001',
      state: 'queued',
    });
    expect(calls[0]?.body).toEqual({
      from: '12025550110',
      to: '12025550123',
      answer_url: 'https://api.example/webhooks/plivo/org_1/answer',
      answer_method: 'POST',
      hangup_url: 'https://api.example/webhooks/plivo/org_1',
      hangup_method: 'POST',
      sip_headers: 'ClientState=abc',
    });
  });

  it('refuses a server call without an answer URL', async () => {
    const { fetchImpl } = stubFetch([]);
    await expect(
      provider(fetchImpl).createCall({
        orgId: 'o',
        from: '+12025550110',
        to: '+12025550123',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('hangs up exactly one call, and never sends an empty or odd call id', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'DELETE',
        url: `${ACCOUNT}/Call/cccccccc-0000-4000-8000-000000000001/`,
        respond: () => new Response(null, { status: 204 }),
      },
    ]);
    const p = provider(fetchImpl);
    await p.endCall('cccccccc-0000-4000-8000-000000000001');
    expect(calls).toHaveLength(1);
    for (const bad of ['', '../Call', 'a/b', 'x'.repeat(65)]) {
      await expect(p.endCall(bad)).rejects.toThrow('invalid_call_id');
    }
    expect(calls).toHaveLength(1);
  });
});

describe('PlivoProvider numbers', () => {
  const numberRoutes: Route[] = [
    { method: 'GET', url: page('/Number/', 0), respond: json(200, fixtureText('numbers-page-1')) },
    { method: 'GET', url: page('/Number/', 20), respond: json(200, fixtureText('numbers-page-2')) },
  ];

  it('lists every page of rented numbers in E.164', async () => {
    const { fetchImpl } = stubFetch(numberRoutes);
    expect(await provider(fetchImpl).listNumbers()).toEqual([
      {
        providerNumberId: '12025550110',
        e164: '+12025550110',
        status: 'active',
        capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
        tenDlc: 'not_required',
        whatsapp: 'none',
      },
      {
        providerNumberId: '12025550111',
        e164: '+12025550111',
        status: 'active',
        capabilities: { voice: true, sms: false, mms: false, whatsapp: false },
        tenDlc: 'not_required',
        whatsapp: 'none',
      },
    ]);
  });

  it('never returns a partial list at the page cap', async () => {
    const { fetchImpl } = stubFetch(numberRoutes);
    await expect(provider(fetchImpl, { maxPages: 1 }).listNumbers()).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  const SEARCH = `${ACCOUNT}/PhoneNumber/?country_iso=US&type=local&services=voice%2Csms&pattern=202&region=DC&city=Washington&limit=5`;

  it('searches with Plivo filters and leaves out restricted numbers', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'GET', url: SEARCH, respond: json(200, fixtureText('phone-numbers-search')) },
    ]);
    const found = await provider(fetchImpl).searchAvailableNumbers({
      country: 'US',
      areaCode: '202',
      region: 'DC',
      locality: 'Washington',
      features: ['sms', 'voice'],
      limit: 5,
    });
    expect(calls).toHaveLength(1);
    expect(found).toEqual([
      {
        e164: '+12025550150',
        locality: 'WASHINGTON',
        region: 'District of Columbia',
        capabilities: { voice: true, sms: true, mms: true },
        upfrontMicros: 0,
        monthlyMicros: 500_000,
        currency: 'USD',
      },
    ]);
  });

  it('widens an unsupported service set and filters the answer itself', async () => {
    const url = `${ACCOUNT}/PhoneNumber/?country_iso=US&type=local&services=voice%2Csms%2Cmms&limit=20`;
    const { fetchImpl } = stubFetch([
      { method: 'GET', url, respond: json(200, fixtureText('phone-numbers-search')) },
    ]);
    const found = await provider(fetchImpl).searchAvailableNumbers({
      country: 'US',
      features: ['voice', 'mms'],
    });
    expect(found.map((n) => n.e164)).toEqual(['+12025550150']);
  });

  it('quotes an exact number, or null', async () => {
    const quoteUrl = (digits: string) =>
      `${ACCOUNT}/PhoneNumber/?country_iso=US&type=local&pattern=${digits}&limit=20`;
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: quoteUrl('2025550151'),
        respond: json(200, fixtureText('phone-numbers-search')),
      },
      {
        method: 'GET',
        url: quoteUrl('2025550152'),
        respond: json(200, fixtureText('phone-numbers-search')),
      },
    ]);
    const p = provider(fetchImpl);
    expect(await p.quoteNumber('+12025550151')).toMatchObject({
      upfrontMicros: 1_000_000,
      monthlyMicros: 800_000,
    });
    // Listed, but restricted: not for sale here.
    expect(await p.quoteNumber('+12025550152')).toBeNull();
  });

  it('refuses an unparsable price', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'GET',
        url: `${ACCOUNT}/PhoneNumber/?country_iso=US&type=local&pattern=2025550150&limit=20`,
        respond: json(200, {
          objects: [{ number: '12025550150', setup_rate: 'free', monthly_rental_rate: '0.5' }],
        }),
      },
    ]);
    await expect(provider(fetchImpl).quoteNumber('+12025550150')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('orders a number onto the application', async () => {
    const { calls, fetchImpl } = stubFetch([
      {
        method: 'POST',
        url: `${ACCOUNT}/PhoneNumber/12025550150/`,
        respond: json(201, fixtureText('number-order-fulfilled')),
      },
      {
        method: 'POST',
        url: `${ACCOUNT}/PhoneNumber/12025550151/`,
        respond: json(201, fixtureText('number-order-pending')),
      },
    ]);
    const p = provider(fetchImpl);
    expect(await p.orderNumber({ e164: '+12025550150', connectionId: null })).toEqual({
      providerOrderId: '8b5a8d6c-0000-4000-8000-000000000004',
      status: 'completed',
      e164: '+12025550150',
    });
    expect(calls[0]?.body).toEqual({ app_id: 'app-fixture-1' });
    expect(await p.orderNumber({ e164: '+12025550151', connectionId: 'app-2' })).toMatchObject({
      status: 'pending',
    });
    expect(calls[1]?.body).toEqual({ app_id: 'app-2' });
  });
});

describe('PlivoProvider balance and usage', () => {
  it('reads cash credits as micros', async () => {
    const { calls, fetchImpl } = stubFetch([
      { method: 'GET', url: `${ACCOUNT}/`, respond: json(200, fixtureText('account')) },
    ]);
    expect(await provider(fetchImpl).fetchBalance()).toEqual({
      balanceMicros: 12_345_000,
      currency: 'USD',
    });
    expect(calls[0]?.headers.get('authorization')).toBe(BASIC);
  });

  it('reads call detail records for the period in UTC', async () => {
    const filters = 'end_time__gte=2026-11-11+00%3A00%3A00&end_time__lt=2026-11-12+00%3A00%3A00&';
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: page('/Call/', 0, filters), respond: json(200, fixtureText('cdrs')) },
    ]);
    expect(
      await provider(fetchImpl).fetchUsage({
        from: '2026-11-11T00:00:00.000Z',
        to: '2026-11-12T00:00:00.000Z',
      }),
    ).toEqual([
      {
        service: 'voice',
        quantity: 60,
        unit: 'second',
        costMicros: 8_500,
        occurredAt: '2026-11-11T10:01:00.000Z',
        providerRef: 'aaaaaaaa-0000-4000-8000-000000000001',
      },
      {
        service: 'voice',
        quantity: 0,
        unit: 'second',
        costMicros: 0,
        occurredAt: '2026-11-11T10:00:00.000Z',
        providerRef: 'aaaaaaaa-0000-4000-8000-000000000002',
      },
    ]);
  });

  it('turns a server error into a typed error', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'GET', url: `${ACCOUNT}/`, respond: json(503, 'Service Unavailable') },
    ]);
    await expect(provider(fetchImpl).fetchBalance()).rejects.toMatchObject({
      status: 503,
      code: 'http_503',
    });
  });
});

describe('parsePlivoTime', () => {
  it('reads Plivo times with and without an offset', () => {
    expect(parsePlivoTime('2026-11-11 10:00:00')).toBe('2026-11-11T10:00:00.000Z');
    expect(parsePlivoTime('2026-11-11 15:30:00+05:30')).toBe('2026-11-11T10:00:00.000Z');
    expect(parsePlivoTime('2026-11-11 10:00:00.123456')).toBe('2026-11-11T10:00:00.123Z');
    expect(parsePlivoTime('yesterday')).toBeNull();
  });
});

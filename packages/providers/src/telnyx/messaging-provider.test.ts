import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyTelnyxError, TelnyxMessagingError } from './messaging-errors';
import { TelnyxMessagingProvider } from './messaging-provider';

const API_KEY = 'KEY_FAKE_0000000000000000';
const BASE = 'https://api.telnyx.com/v2';
const OUR = '+12025550100';
const CONTACT = '+12025550123';
const IDEMPOTENCY_KEY = 'msg_0123456789abcdef0123456789abcdef';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../test/fixtures/telnyx/messaging/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** An injected fetch that answers every request with `respond`. It never reaches the network. */
function stubFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const provider = (fetchImpl: typeof fetch) =>
  new TelnyxMessagingProvider({ apiKey: API_KEY, fetch: fetchImpl });

const sms = { orgId: 'org_1', from: OUR, to: CONTACT, idempotencyKey: IDEMPOTENCY_KEY };

async function thrown(promise: Promise<unknown>): Promise<TelnyxMessagingError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelnyxMessagingError) return error;
    throw error;
  }
  throw new Error('expected a TelnyxMessagingError');
}

describe('TelnyxMessagingProvider.sendSms', () => {
  it('POSTs /messages with from, to and text, and the bearer key', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-sms-response')));
    await provider(fetchImpl).sendSms({ ...sms, body: 'Hello, World!' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/messages`);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(call?.body).toEqual({ from: OUR, to: CONTACT, text: 'Hello, World!' });
  });

  it('returns data.id as the provider message id', async () => {
    const { fetchImpl } = stubFetch(json(200, fixture('send-sms-response')));
    const result = await provider(fetchImpl).sendSms({ ...sms, body: 'Hello, World!' });
    expect(result).toEqual({
      providerMessageId: '40385f64-5717-4562-b3fc-2c963f66afa6',
      state: 'queued',
    });
  });

  it('honours a custom apiBase', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-sms-response')));
    const p = new TelnyxMessagingProvider({
      apiKey: API_KEY,
      fetch: fetchImpl,
      apiBase: 'https://telnyx.example.test/v2',
    });
    await p.sendSms({ ...sms, body: 'hi' });
    expect(calls[0]?.url).toBe('https://telnyx.example.test/v2/messages');
  });

  it('omits an idempotency key that Telnyx would reject', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-sms-response')));
    await provider(fetchImpl).sendSms({ ...sms, idempotencyKey: 'not valid!', body: 'hi' });
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
  });
});

describe('TelnyxMessagingProvider.sendWhatsApp', () => {
  it('POSTs /messages/whatsapp with a free-text body', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-whatsapp-response')));
    await provider(fetchImpl).sendWhatsApp({
      ...sms,
      body: 'Thanks for reaching out! How can we help?',
    });
    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/messages/whatsapp`);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers.get('idempotency-key')).toBe(IDEMPOTENCY_KEY);
    expect(call?.body).toEqual(fixture('send-whatsapp-text-request'));
  });

  it('sends a template with its body parameters in order', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-whatsapp-response')));
    await provider(fetchImpl).sendWhatsApp({
      ...sms,
      body: 'Hi John, order ORD-12345 is confirmed.',
      templateId: 'tpl_0123456789abcdef0123456789abcdef',
      template: {
        name: 'order_confirmation',
        language: 'en_US',
        parameters: ['John', 'ORD-12345'],
      },
    });
    expect(calls[0]?.url).toBe(`${BASE}/messages/whatsapp`);
    expect(calls[0]?.body).toEqual(fixture('send-whatsapp-template-request'));
  });

  it('omits components for a template without parameters', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-whatsapp-response')));
    await provider(fetchImpl).sendWhatsApp({
      ...sms,
      template: { name: 'hello_world', language: 'en_US', parameters: [] },
    });
    expect(calls[0]?.body).toEqual({
      from: OUR,
      to: CONTACT,
      whatsapp_message: {
        type: 'template',
        template: { name: 'hello_world', language: { policy: 'deterministic', code: 'en_US' } },
      },
    });
  });

  it('returns data.id as the provider message id', async () => {
    const { fetchImpl } = stubFetch(json(200, fixture('send-whatsapp-response')));
    const result = await provider(fetchImpl).sendWhatsApp({ ...sms, body: 'hi' });
    expect(result).toEqual({
      providerMessageId: '4031938e-60e4-4235-a8dd-0b1c55a23e7a',
      state: 'queued',
    });
  });

  it('refuses a send with neither a body nor a template, without calling Telnyx', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, fixture('send-whatsapp-response')));
    await expect(provider(fetchImpl).sendWhatsApp({ ...sms })).rejects.toThrow(
      'WhatsApp send needs a body or a template',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('TelnyxMessagingProvider errors', () => {
  it('maps a 400 with code 40300 to opted_out', async () => {
    const { fetchImpl } = stubFetch(json(400, fixture('error-40300-stop')));
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.status).toBe(400);
    expect(error.code).toBe('40300');
    expect(error.failure.code).toBe('opted_out');
  });

  it('maps a 401 to provider_auth', async () => {
    const { fetchImpl } = stubFetch(json(401, fixture('error-401-auth')));
    const error = await thrown(provider(fetchImpl).sendWhatsApp({ ...sms, body: 'hi' }));
    expect(error.status).toBe(401);
    expect(error.code).toBe('10009');
    expect(error.failure).toEqual({
      code: 'provider_auth',
      message: 'Telnyx rejected the API key.',
      retryable: false,
    });
  });

  it('never puts the phone number or the key from a 400 body in the message', async () => {
    const { fetchImpl } = stubFetch(json(400, fixture('error-400-invalid-to')));
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.name).toBe('TelnyxMessagingError');
    expect(error.message).toBe('Telnyx messaging error: status 400, code 40310');
    expect(error.message).not.toContain(CONTACT);
    expect(error.message).not.toContain('2025550123');
    expect(error.message).not.toContain(API_KEY);
    expect(JSON.stringify(error.failure)).not.toContain(CONTACT);
    expect(error.failure.code).toBe('invalid_number');
  });

  it('sanitizes an error code that is not a plain token', async () => {
    const { fetchImpl } = stubFetch(
      json(400, { errors: [{ code: `${CONTACT} ${API_KEY}`, title: 'x' }] }),
    );
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('Telnyx messaging error: status 400, code unknown');
  });

  it('accepts a numeric Telnyx error code', async () => {
    const { fetchImpl } = stubFetch(json(400, { errors: [{ code: 40300, title: 'x' }] }));
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.code).toBe('40300');
    expect(error.failure.code).toBe('opted_out');
  });

  it('reads an unparseable error body as code unknown', async () => {
    const { fetchImpl } = stubFetch(
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown');
    expect(error.failure).toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('maps a network failure to a retryable provider_error', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new TypeError(`fetch failed for ${CONTACT}`);
    });
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.status).toBe(0);
    expect(error.code).toBe('network_error');
    expect(error.message).not.toContain(CONTACT);
    expect(error.failure).toMatchObject({ code: 'provider_error', retryable: true });
  });

  it('passes a time limit signal on both send requests', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return json(200, fixture('send-sms-response'))();
    }) as typeof fetch;
    await provider(fetchImpl).sendSms({ ...sms, body: 'hi' });
    await provider(fetchImpl).sendWhatsApp({ ...sms, body: 'hi' });
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
    }
  });

  it.each(['sendSms', 'sendWhatsApp'] as const)(
    '%s gives up after the time limit with a status 0 timeout provider_error',
    async (method) => {
      const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })) as typeof fetch;
      const quick = new TelnyxMessagingProvider({
        apiKey: API_KEY,
        fetch: hanging,
        sendTimeoutMs: 20,
      });
      const error = await thrown(quick[method]({ ...sms, body: 'hi' }));
      expect(error).toMatchObject({ status: 0, code: 'timeout' });
      expect(error.failure.code).toBe('provider_error');
      expect(error.message).not.toContain(CONTACT);
    },
  );

  it('maps an invalid JSON success body to provider_error', async () => {
    const { fetchImpl } = stubFetch(() => new Response('{not json', { status: 200 }));
    const error = await thrown(provider(fetchImpl).sendSms({ ...sms, body: 'hi' }));
    expect(error.status).toBe(200);
    expect(error.code).toBe('invalid_response');
    expect(error.failure.code).toBe('provider_error');
  });

  it('maps a success body without data.id to provider_error', async () => {
    const { fetchImpl } = stubFetch(json(200, { data: { record_type: 'message' } }));
    const error = await thrown(provider(fetchImpl).sendWhatsApp({ ...sms, body: 'hi' }));
    expect(error.code).toBe('invalid_response');
    expect(error.failure.code).toBe('provider_error');
  });
});

describe('classifyTelnyxError', () => {
  it('maps 401 and 403 to provider_auth', () => {
    for (const status of [401, 403]) {
      expect(classifyTelnyxError(status, '10009')).toEqual({
        code: 'provider_auth',
        message: 'Telnyx rejected the API key.',
        retryable: false,
      });
    }
  });

  it('maps 429 to a retryable provider_rate_limited', () => {
    expect(classifyTelnyxError(429, '10011')).toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
    });
  });

  it('maps 40300 (STOP) to opted_out, whatever the status', () => {
    for (const status of [400, 403, 422]) {
      expect(classifyTelnyxError(status, '40300')).toEqual({
        code: 'opted_out',
        message: 'The recipient has opted out of messages from this number.',
        retryable: false,
      });
    }
  });

  it('maps the invalid-destination codes to invalid_number', () => {
    for (const code of ['40001', '40012', '40310']) {
      expect(classifyTelnyxError(400, code)).toMatchObject({
        code: 'invalid_number',
        retryable: false,
      });
    }
  });

  it('maps any other 4xx to provider_rejected', () => {
    for (const [status, code] of [
      [400, '40302'],
      [404, 'unknown'],
      [422, '10015'],
    ] as const) {
      expect(classifyTelnyxError(status, code)).toMatchObject({
        code: 'provider_rejected',
        retryable: false,
      });
    }
  });

  it('maps 5xx and network errors (status 0) to a retryable provider_error', () => {
    for (const [status, code] of [
      [500, 'unknown'],
      [503, '10016'],
      [0, 'network_error'],
    ] as const) {
      expect(classifyTelnyxError(status, code)).toMatchObject({
        code: 'provider_error',
        retryable: true,
      });
    }
  });

  it('gives every failure a user-facing message', () => {
    for (const [status, code] of [
      [401, 'x'],
      [429, 'x'],
      [400, '40300'],
      [400, '40310'],
      [400, 'x'],
      [500, 'x'],
    ] as const) {
      expect(classifyTelnyxError(status, code).message.length).toBeGreaterThan(0);
    }
  });
});

describe('TelnyxMessagingProvider.ownsNumber', () => {
  const owned = fixture('list-phone-numbers-owned') as {
    data: Array<Record<string, unknown>>;
    meta: unknown;
  };
  const listing = (entries: Array<Record<string, unknown>>) =>
    json(200, { ...owned, data: entries });
  const listed = owned.data[0] as Record<string, unknown>;

  it('GETs /phone_numbers filtered by the digits, with the bearer key', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, owned));
    await provider(fetchImpl).ownsNumber(OUR);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe('GET');
    const url = new URL(call?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/phone_numbers`);
    // Telnyx returns nothing for a filter with non-numerical characters, so no '+'.
    expect(url.searchParams.get('filter[phone_number]')).toBe('12025550100');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call?.body).toBeUndefined();
  });

  it('is true when the account lists exactly this number', async () => {
    const { fetchImpl } = stubFetch(json(200, owned));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(true);
  });

  it('is false for an empty listing', async () => {
    const { fetchImpl } = stubFetch(json(200, fixture('list-phone-numbers-empty')));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(false);
  });

  it('is false when only a longer number containing the digits is listed', async () => {
    const { fetchImpl } = stubFetch(listing([{ ...listed, phone_number: '+120255501001' }]));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(false);
  });

  // Allowlist (ruling AO): only a number the account currently controls may become a sender.
  it.each(['active', 'port-out-pending'])('is true for a %s number', async (status) => {
    const { fetchImpl } = stubFetch(listing([{ ...listed, status }]));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(true);
  });

  it.each([
    'port-pending',
    'port-failed',
    'purchase-pending',
    'purchase-failed',
    'deleted',
    'ported-out',
    'emergency-only',
    'requirement-info-pending',
    'requirement-info-under-review',
    'requirement-info-exception',
    'provision-pending',
    'something-new',
    '',
    'ACTIVE',
  ])('is false for a number whose status is %j', async (status) => {
    const { fetchImpl } = stubFetch(listing([{ ...listed, status }]));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(false);
  });

  it('is false for a listed number with no status', async () => {
    const { status: _omitted, ...withoutStatus } = listed;
    const { fetchImpl } = stubFetch(listing([withoutStatus]));
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(false);
  });

  it('is true when one exact match is active among refused duplicates', async () => {
    const { fetchImpl } = stubFetch(
      listing([
        { ...listed, status: 'deleted' },
        { ...listed, status: 'active' },
      ]),
    );
    expect(await provider(fetchImpl).ownsNumber(OUR)).toBe(true);
  });

  it('bounds the request with an abort signal', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return json(200, owned)();
    }) as typeof fetch;
    await provider(fetchImpl).ownsNumber(OUR);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('throws a status 0 timeout error when Telnyx does not answer in time', async () => {
    const slow = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const error = await thrown(provider(slow).ownsNumber(OUR));
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('gives up after the timeout when fetch waits on the signal', async () => {
    const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const quick = new TelnyxMessagingProvider({
      apiKey: API_KEY,
      fetch: hanging,
      ownershipTimeoutMs: 20,
    });
    const error = await thrown(quick.ownsNumber(OUR));
    expect(error).toMatchObject({ status: 0, code: 'timeout' });
  });

  it('throws a 401 TelnyxMessagingError carrying no key, number or body', async () => {
    const { fetchImpl } = stubFetch(json(401, fixture('error-401-auth')));
    const error = await thrown(provider(fetchImpl).ownsNumber(OUR));
    expect(error.status).toBe(401);
    expect(error.code).toBe('10009');
    expect(error.failure.code).toBe('provider_auth');
    for (const secret of [API_KEY, OUR, '12025550100', 'Authentication failed']) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('throws on a server error, a network failure and an unreadable listing', async () => {
    const server = await thrown(provider(stubFetch(json(500, {})).fetchImpl).ownsNumber(OUR));
    expect(server.status).toBe(500);
    const offline = await thrown(
      provider((async () => {
        throw new TypeError('network down');
      }) as typeof fetch).ownsNumber(OUR),
    );
    expect(offline.status).toBe(0);
    const garbled = await thrown(
      provider(stubFetch(json(200, { data: 'nope' })).fetchImpl).ownsNumber(OUR),
    );
    expect(garbled).toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('refuses a number that is not E.164 without calling Telnyx', async () => {
    const { calls, fetchImpl } = stubFetch(json(200, owned));
    expect(await provider(fetchImpl).ownsNumber('12')).toBe(false);
    expect(calls).toEqual([]);
  });
});

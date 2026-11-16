import { describe, expect, it } from 'vitest';
import { runAdapterContract } from '../contract.test-helpers';
import { encodeForm } from './form';
import { mapPlivoCause, normalizePlivo, plivoAddress, RECEIVED_AT_FIELD } from './normalize';
import { NONCE_HEADER, SIGNATURE_HEADER, signPlivoV3 } from './signature';
import { fixtureFields } from './test-fetch.test-helpers';
import { PlivoWebhookAdapter } from './webhook';

const URL_EVENTS = 'https://api.example.test/webhooks/plivo/org_fixture';
const TOKEN = 'fixture-auth-token-value-0000000000';
const NOW = Date.parse('2026-11-11T10:00:07Z');

const adapter = (url = URL_EVENTS) =>
  new PlivoWebhookAdapter({ authToken: TOKEN, url, now: () => NOW });

async function signed(body: Uint8Array, url = URL_EVENTS): Promise<Headers> {
  const signature = await signPlivoV3({
    url,
    nonce: '12345678901234567890',
    authToken: TOKEN,
    body,
  });
  return new Headers({
    [SIGNATURE_HEADER]: signature ?? '',
    [NONCE_HEADER]: '12345678901234567890',
  });
}

/** The contract's bodies as Plivo would post them: form fields, objects as JSON text. */
const encodeContract = (value: unknown): Uint8Array =>
  encodeForm(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : JSON.stringify(v),
      ]),
    ),
  );

runAdapterContract('plivo', async (body) => ({ adapter: adapter(), headers: await signed(body) }), {
  encode: encodeContract,
  envelope: (base, type) => ({ CallUUID: base.resource_id, Event: type }),
});

const parsed = (name: string) => {
  const result = adapter().parse(encodeForm(fixtureFields(name)));
  if (!result.ok) throw new Error('fixture did not parse');
  return result.value;
};

describe('PlivoWebhookAdapter.verify', () => {
  it('checks the URL the request was posted to', async () => {
    const body = encodeForm(fixtureFields('hangup-normal'));
    const headers = await signed(body);
    expect(await adapter().verify(headers, body)).toBe(true);
    expect(await adapter(`${URL_EVENTS}/answer`).verify(headers, body)).toBe(false);
    expect(
      await adapter('https://api.example.test/webhooks/plivo/org_other').verify(headers, body),
    ).toBe(false);
  });

  it('refuses everything without an auth token', async () => {
    const body = encodeForm(fixtureFields('hangup-normal'));
    const noToken = new PlivoWebhookAdapter({ authToken: '', url: URL_EVENTS });
    expect(await noToken.verify(await signed(body), body)).toBe(false);
  });
});

describe('PlivoWebhookAdapter.parse', () => {
  it('reads a browser call start with its client state, stamped with the time received', () => {
    const outcome = parsed('answer-browser');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event).toMatchObject({
      provider: 'plivo',
      externalEventId: 'cccccccc-0000-4000-8000-000000000001:start',
      type: 'call.initiated',
      occurredAt: '2026-11-11T10:00:07.000Z',
      resourceId: 'cccccccc-0000-4000-8000-000000000001',
    });
    expect(outcome.body).toMatchObject({ [RECEIVED_AT_FIELD]: '2026-11-11T10:00:07.000Z' });
  });

  it('gives each callback of one call its own external id', () => {
    const ids = ['answer-browser', 'dial-answer', 'dial-hangup-busy', 'hangup-normal'].map((n) => {
      const outcome = parsed(n);
      return outcome.kind === 'event' ? outcome.event.externalEventId : null;
    });
    expect(ids).toEqual([
      'cccccccc-0000-4000-8000-000000000001:start',
      'cccccccc-0000-4000-8000-000000000001:dial:answer',
      'cccccccc-0000-4000-8000-000000000001:dial:hangup',
      'cccccccc-0000-4000-8000-000000000001:hangup',
    ]);
  });

  it('ignores dial callbacks it does not model', () => {
    const body = encodeForm({ ...fixtureFields('dial-answer'), DialAction: 'digits' });
    expect(adapter().parse(body)).toEqual({
      ok: true,
      value: { kind: 'ignored', eventType: 'dial.digits' },
    });
  });

  it('refuses a body without a call id, or one that is not UTF-8', () => {
    expect(adapter().parse(encodeForm({ Event: 'Hangup' }))).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(adapter().parse(encodeForm({ Event: 'Hangup', CallUUID: 'bad/id' }))).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(adapter().parse(new Uint8Array([0x45, 0x3d, 0xff]))).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
  });
});

describe('PlivoWebhookAdapter.normalize', () => {
  const normalized = (name: string) => {
    const outcome = parsed(name);
    return outcome.kind === 'event' ? adapter().normalize(outcome.body) : null;
  };

  it('a browser call is KNOQRA-outbound and dialing, found by its client state', () => {
    expect(normalized('answer-browser')).toEqual({
      kind: 'call',
      provider: 'plivo',
      providerCallId: 'cccccccc-0000-4000-8000-000000000001',
      clientState: '0123456789abcdef0123456789abcdef',
      signal: { type: 'dialing' },
      direction: 'outbound',
      from: 'sip:knoqrafixture0000123456789012@phone.plivo.com',
      to: '+12025550123',
      occurredAt: '2026-11-11T10:00:07.000Z',
      billableSeconds: null,
      voicemail: null,
      orgHint: null,
    });
  });

  it('a call to a Plivo number is inbound and ringing, with E.164 parties', () => {
    expect(normalized('answer-inbound')).toMatchObject({
      clientState: null,
      signal: { type: 'ringing' },
      direction: 'inbound',
      from: '+12025550123',
      to: '+12025550110',
    });
  });

  it('maps the far end answering and hanging up', () => {
    expect(normalized('dial-answer')).toMatchObject({
      signal: { type: 'answered' },
      direction: 'outbound',
      from: '+12025550110',
      to: '+12025550123',
    });
    expect(normalized('dial-hangup-busy')).toMatchObject({
      signal: { type: 'hangup', cause: 'busy' },
    });
    expect(normalized('hangup-normal')).toMatchObject({
      signal: { type: 'hangup', cause: 'normal' },
      direction: 'outbound',
    });
  });

  it('returns null for a stored body it cannot read', () => {
    expect(normalizePlivo(null)).toBeNull();
    expect(normalizePlivo(['x'])).toBeNull();
    expect(normalizePlivo({ Event: 'Hangup', CallUUID: 'c-1' })).toBeNull();
  });
});

describe('Plivo mapping helpers', () => {
  it('maps statuses and cause names', () => {
    expect(mapPlivoCause('completed', 'Normal Hangup')).toBe('normal');
    expect(mapPlivoCause('completed', 'Busy Line')).toBe('busy');
    expect(mapPlivoCause('no-answer', undefined)).toBe('no_answer');
    expect(mapPlivoCause('timeout', undefined)).toBe('no_answer');
    expect(mapPlivoCause('cancel', undefined)).toBe('canceled');
    expect(mapPlivoCause(undefined, 'Rejected')).toBe('rejected');
    expect(mapPlivoCause('exploded', undefined)).toBe('failed');
  });

  it('turns Plivo numbers into E.164 and leaves SIP addresses alone', () => {
    expect(plivoAddress('12025550123')).toBe('+12025550123');
    expect(plivoAddress('+12025550123')).toBe('+12025550123');
    expect(plivoAddress('sip:a@phone.plivo.com')).toBe('sip:a@phone.plivo.com');
    expect(plivoAddress(undefined)).toBe('');
  });
});

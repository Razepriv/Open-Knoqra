import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAdapterContract } from '../contract.test-helpers';
import type { NormalizedEvent } from '../events';
import { telnyxOutboundStart } from './normalize';
import { TelnyxWebhookAdapter } from './webhook';

/** Narrows to a call event. */
const callOf = (event: NormalizedEvent | null) => (event?.kind === 'call' ? event : null);

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeyPair = { publicKey: Key; privateKey: Key };

const enc = new TextEncoder();
const NOW_MS = Date.parse('2026-11-11T10:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as KeyPair;
const publicKeyBase64 = toBase64(
  new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)),
);

function adapter(overrides: { toleranceSeconds?: number } = {}) {
  return new TelnyxWebhookAdapter({ publicKeyBase64, now: () => NOW_MS, ...overrides });
}

async function sign(body: Uint8Array, timestamp: number = NOW_S): Promise<Headers> {
  const prefix = enc.encode(`${timestamp}|`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message);
  return new Headers({
    'telnyx-signature-ed25519': toBase64(new Uint8Array(sig)),
    'telnyx-timestamp': String(timestamp),
  });
}

runAdapterContract('telnyx', async (body) => ({ adapter: adapter(), headers: await sign(body) }), {
  envelope: (base, type) => ({
    data: { id: base.id, event_type: type, occurred_at: base.occurred_at, payload: {} },
  }),
});

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../test/fixtures/telnyx/${name}.json`, import.meta.url)));

const fixtureJson = (name: string) => JSON.parse(new TextDecoder().decode(fixture(name)));

describe('TelnyxWebhookAdapter.verify', () => {
  const body = enc.encode('{"data":{}}');

  it('rejects a missing signature header', async () => {
    const headers = await sign(body);
    headers.delete('telnyx-signature-ed25519');
    expect(await adapter().verify(headers, body)).toBe(false);
  });

  it('rejects a missing timestamp header', async () => {
    const headers = await sign(body);
    headers.delete('telnyx-timestamp');
    expect(await adapter().verify(headers, body)).toBe(false);
  });

  it('rejects a non-base64 signature and a wrong key', async () => {
    const headers = await sign(body);
    headers.set('telnyx-signature-ed25519', '!!!not base64!!!');
    expect(await adapter().verify(headers, body)).toBe(false);
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as KeyPair;
    const otherKey = toBase64(
      new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)),
    );
    const stranger = new TelnyxWebhookAdapter({ publicKeyBase64: otherKey, now: () => NOW_MS });
    expect(await stranger.verify(await sign(body), body)).toBe(false);
  });

  it('rejects a stale timestamp and a future timestamp', async () => {
    expect(await adapter().verify(await sign(body, NOW_S - 301), body)).toBe(false);
    expect(await adapter().verify(await sign(body, NOW_S + 301), body)).toBe(false);
  });

  it('accepts a timestamp at the tolerance boundary', async () => {
    expect(await adapter().verify(await sign(body, NOW_S - 300), body)).toBe(true);
    expect(await adapter().verify(await sign(body, NOW_S + 300), body)).toBe(true);
  });

  it('honors a custom tolerance and rejects a non-numeric timestamp', async () => {
    const tight = adapter({ toleranceSeconds: 10 });
    expect(await tight.verify(await sign(body, NOW_S - 11), body)).toBe(false);
    const headers = await sign(body);
    headers.set('telnyx-timestamp', 'yesterday');
    expect(await adapter().verify(headers, body)).toBe(false);
  });

  it('rejects a signature made for timestamp T when the header says T+1', async () => {
    const headers = await sign(body, NOW_S);
    headers.set('telnyx-timestamp', String(NOW_S + 1));
    expect(await adapter().verify(headers, body)).toBe(false);
  });

  it('returns false for an unusable public key instead of throwing', async () => {
    const bad = new TelnyxWebhookAdapter({ publicKeyBase64: 'AAAA', now: () => NOW_MS });
    expect(await bad.verify(await sign(body), body)).toBe(false);
  });
});

describe('TelnyxWebhookAdapter.parse', () => {
  it('models call.initiated, call.answered, call.hangup and machine detection', () => {
    const cases = [
      ['call-initiated-outgoing', 'call.initiated'],
      ['call-answered', 'call.answered'],
      ['call-hangup-normal', 'call.completed'],
      ['call-machine-detection-ended', 'call.voicemail'],
    ] as const;
    for (const [name, type] of cases) {
      const out = adapter().parse(fixture(name));
      expect(out.ok && out.value.kind === 'event' && out.value.event.type).toBe(type);
    }
  });

  it('returns the parsed body and the call control id as resource id', () => {
    const out = adapter().parse(fixture('call-answered'));
    if (!out.ok || out.value.kind !== 'event') throw new Error('expected event');
    expect(out.value.event.provider).toBe('telnyx');
    expect(out.value.event.externalEventId).toBe('00000000-0000-4000-8000-000000000002');
    expect(out.value.event.resourceId).toBe('v3:outgoing-call-1');
    expect(out.value.body).toEqual(fixtureJson('call-answered'));
  });

  it('ignores a well-formed event it does not model', () => {
    expect(adapter().parse(fixture('call-dtmf-received'))).toEqual({
      ok: true,
      value: { kind: 'ignored', eventType: 'call.dtmf.received' },
    });
  });

  it('rejects an event without a call control id and a non-UTF-8 body', () => {
    const noId = enc.encode(
      JSON.stringify({
        data: {
          id: 'x',
          event_type: 'call.answered',
          occurred_at: '2026-11-11T10:00:00Z',
          payload: {},
        },
      }),
    );
    expect(adapter().parse(noId)).toEqual({ ok: false, error: 'invalid_payload' });
    expect(adapter().parse(new Uint8Array([0x7b, 0xff, 0x7d]))).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
  });
});

describe('TelnyxWebhookAdapter.normalize', () => {
  const normalized = (name: string) => adapter().normalize(fixtureJson(name));
  const base = { kind: 'call', provider: 'telnyx', voicemail: null, orgHint: null } as const;

  it.each([
    [
      'call-initiated-outgoing',
      {
        ...base,
        providerCallId: 'v3:outgoing-call-1',
        clientState: 'idem_key_1',
        signal: { type: 'dialing' },
        direction: 'outbound',
        from: '+12025550101',
        to: '+12025550123',
        occurredAt: '2026-11-11T10:00:00.000000Z',
        billableSeconds: null,
      },
    ],
    [
      'call-answered',
      {
        ...base,
        providerCallId: 'v3:outgoing-call-1',
        clientState: 'idem_key_1',
        signal: { type: 'answered' },
        direction: 'outbound',
        from: '+12025550101',
        to: '+12025550123',
        occurredAt: '2026-11-11T10:00:05.000000Z',
        billableSeconds: null,
      },
    ],
    [
      'call-hangup-normal',
      {
        ...base,
        providerCallId: 'v3:outgoing-call-1',
        clientState: 'idem_key_1',
        signal: { type: 'hangup', cause: 'normal' },
        direction: 'outbound',
        from: '+12025550101',
        to: '+12025550123',
        occurredAt: '2026-11-11T10:01:05.000000Z',
        billableSeconds: null,
      },
    ],
    [
      'call-hangup-busy',
      {
        ...base,
        providerCallId: 'v3:outgoing-call-2',
        clientState: 'idem_key_2',
        signal: { type: 'hangup', cause: 'busy' },
        direction: 'outbound',
        from: '+12025550101',
        to: '+12025550190',
        occurredAt: '2026-11-11T10:00:08.000000Z',
        billableSeconds: null,
      },
    ],
    [
      'call-initiated-incoming',
      {
        ...base,
        providerCallId: 'v3:incoming-call-1',
        clientState: null,
        signal: { type: 'ringing' },
        direction: 'inbound',
        from: '+12025550142',
        to: '+12025550101',
        occurredAt: '2026-11-11T11:00:00.000000Z',
        billableSeconds: null,
      },
    ],
  ])('normalizes %s', (name, expected) => {
    expect(normalized(name)).toEqual(expected);
  });

  it('returns null for machine detection and for the ignored dtmf event', () => {
    expect(normalized('call-machine-detection-ended')).toBeNull();
    expect(normalized('call-dtmf-received')).toBeNull();
  });

  it('returns null for a body that is not a Telnyx envelope', () => {
    expect(adapter().normalize({ nope: true })).toBeNull();
    expect(adapter().normalize(null)).toBeNull();
  });

  it('maps hangup causes', () => {
    const hangup = (cause: string) => {
      const body = fixtureJson('call-hangup-busy');
      body.data.payload.hangup_cause = cause;
      return callOf(adapter().normalize(body))?.signal;
    };
    const cases: [string, string][] = [
      ['normal_clearing', 'normal'],
      ['user_busy', 'busy'],
      ['timeout', 'no_answer'],
      ['no_answer', 'no_answer'],
      ['call_rejected', 'rejected'],
      ['originator_cancel', 'canceled'],
      ['unallocated_number', 'failed'],
    ];
    for (const [telnyx, cause] of cases) expect(hangup(telnyx)).toEqual({ type: 'hangup', cause });
  });

  it('keeps the hangup signal for an answered call that ends with a non-normal cause', () => {
    const body = fixtureJson('call-hangup-normal');
    body.data.payload.hangup_cause = 'unallocated_number';
    const out = callOf(adapter().normalize(body));
    expect(out?.signal).toEqual({ type: 'hangup', cause: 'failed' });
    expect(out?.billableSeconds).toBeNull();
  });

  it('still normalizes a hangup missing from, to and direction, but not other events', () => {
    const hangup = fixtureJson('call-hangup-normal');
    hangup.data.payload.from = undefined;
    hangup.data.payload.to = undefined;
    hangup.data.payload.direction = undefined;
    const out = adapter().normalize(hangup);
    expect(out).toMatchObject({
      signal: { type: 'hangup', cause: 'normal' },
      from: '',
      to: '',
      direction: 'outbound',
    });
    const answered = fixtureJson('call-answered');
    answered.data.payload.from = undefined;
    expect(adapter().normalize(answered)).toBeNull();
  });

  it('decodes an invalid client_state as null', () => {
    const body = fixtureJson('call-answered');
    body.data.payload.client_state = '%%%';
    expect(callOf(adapter().normalize(body))?.clientState).toBeNull();
  });
});

describe('TelnyxWebhookAdapter message events', () => {
  const messaging = (name: string) => `messaging/${name}`;

  it('parses message webhooks as events keyed by the provider message id', () => {
    const cases = [
      ['webhook-sms-received', 'message.received', '00000000-0000-4000-8000-0000000b0001'],
      [
        'webhook-sms-finalized-delivered',
        'message.delivered',
        '00000000-0000-4000-8000-0000000a0001',
      ],
      ['webhook-whatsapp-read', 'message.read', '00000000-0000-4000-8000-0000000a0002'],
    ] as const;
    for (const [name, type, resourceId] of cases) {
      const out = adapter().parse(fixture(messaging(name)));
      if (!out.ok || out.value.kind !== 'event') throw new Error(`expected event for ${name}`);
      expect(out.value.event).toMatchObject({ provider: 'telnyx', type, resourceId });
      expect(out.value.event.externalEventId).toBe(fixtureJson(messaging(name)).data.id);
      expect(out.value.body).toEqual(fixtureJson(messaging(name)));
    }
  });

  it('ignores a well-formed message event M3 does not track', () => {
    const out = adapter().parse(fixture(messaging('webhook-sms-finalized-unknown-status')));
    expect(out).toEqual({ ok: true, value: { kind: 'ignored', eventType: 'message.finalized' } });
    const mms = adapter().parse(fixture(messaging('webhook-mms-only-received')));
    expect(mms).toEqual({ ok: true, value: { kind: 'ignored', eventType: 'message.received' } });
  });

  it('still parses call events unchanged', () => {
    const out = adapter().parse(fixture('call-answered'));
    expect(out.ok && out.value.kind === 'event' && out.value.event.resourceId).toBe(
      'v3:outgoing-call-1',
    );
  });

  it('normalizes an inbound SMS into a message event with its payload', () => {
    const out = adapter().normalize(fixtureJson(messaging('webhook-sms-received')));
    expect(out).toEqual({
      kind: 'message',
      provider: 'telnyx',
      event: {
        provider: 'telnyx',
        externalEventId: '00000000-0000-4000-8000-0000000e0001',
        type: 'message.received',
        occurredAt: '2026-11-13T20:16:07.588+00:00',
        resourceId: '00000000-0000-4000-8000-0000000b0001',
        payload: {
          channel: 'sms',
          from: '+12025550123',
          to: '+12025550100',
          body: 'Hello from Telnyx!',
        },
      },
      payload: {
        channel: 'sms',
        from: '+12025550123',
        to: '+12025550100',
        body: 'Hello from Telnyx!',
      },
    });
  });

  it('normalizes receipts with the channel, and a failure with its code', () => {
    const read = adapter().normalize(fixtureJson(messaging('webhook-whatsapp-read')));
    expect(read?.kind === 'message' && read.event.type).toBe('message.read');
    expect(read?.kind === 'message' && read.payload.channel).toBe('whatsapp');
    const failed = adapter().normalize(fixtureJson(messaging('webhook-sms-finalized-failed')));
    expect(failed?.kind === 'message' && failed.event.type).toBe('message.failed');
    expect(failed?.kind === 'message' && failed.payload.error?.code).toMatch(/^\w+$/);
  });

  it('returns null for a message event it does not track', () => {
    expect(
      adapter().normalize(fixtureJson(messaging('webhook-sms-finalized-unknown-status'))),
    ).toBeNull();
  });
});

describe('TelnyxWebhookAdapter inbound calls with null fields', () => {
  // The shape Telnyx sends for a call to one of our numbers: no client state (only calls we place
  // set it), so `client_state` is null, and a hangup can carry other nulls. Seen live 2026-11-15,
  // when every inbound call event was refused as invalid_payload.
  const inbound = (eventType: string, payload: Record<string, unknown>) =>
    enc.encode(
      JSON.stringify({
        data: {
          id: `evt-${eventType}`,
          event_type: eventType,
          occurred_at: '2026-11-15T19:28:36.174752Z',
          record_type: 'event',
          payload,
        },
      }),
    );
  const initiated = {
    call_control_id: 'v3:inbound-1',
    call_leg_id: 'leg-1',
    call_session_id: 'session-1',
    caller_id_name: '+12025550123',
    client_state: null,
    connection_id: '1234567890',
    direction: 'incoming',
    from: '+12025550123',
    to: '+12025550100',
    start_time: '2026-11-15T19:28:36.174752Z',
    state: 'bridging',
  };
  const hangup = {
    call_control_id: 'v3:inbound-1',
    client_state: null,
    from: '+12025550123',
    to: '+12025550100',
    hangup_cause: 'unspecified',
    hangup_source: 'unknown',
    sip_hangup_cause: '480',
    telnyx_error: null,
    start_time: '2026-11-15T19:28:36.374753Z',
    end_time: '2026-11-15T19:28:36.414752Z',
  };

  it('parses an inbound call.initiated with a null client_state', () => {
    const parsed = adapter().parse(inbound('call.initiated', initiated));
    expect(parsed.ok && parsed.value.kind).toBe('event');
  });

  it('parses an inbound call.hangup with null fields', () => {
    const parsed = adapter().parse(inbound('call.hangup', hangup));
    expect(parsed.ok && parsed.value.kind).toBe('event');
  });

  it('normalizes the inbound call as ringing with no client state', () => {
    const body = JSON.parse(new TextDecoder().decode(inbound('call.initiated', initiated)));
    const call = callOf(adapter().normalize(body));
    expect(call).toMatchObject({
      providerCallId: 'v3:inbound-1',
      direction: 'inbound',
      clientState: null,
      from: '+12025550123',
      to: '+12025550100',
      signal: { type: 'ringing' },
    });
  });

  it('treats a null direction, from or to like a missing one', () => {
    const body = JSON.parse(
      new TextDecoder().decode(
        inbound('call.hangup', { ...hangup, direction: null, from: null, to: null }),
      ),
    );
    const call = callOf(adapter().normalize(body));
    expect(call).toMatchObject({ direction: 'outbound', from: '', to: '' });
  });
});

describe('telnyxOutboundStart', () => {
  it('reads an outgoing call.initiated', () => {
    expect(telnyxOutboundStart(fixtureJson('call-initiated-outgoing'))).toEqual({
      callControlId: 'v3:outgoing-call-1',
      to: '+12025550123',
      from: '+12025550101',
      clientState: 'idem_key_1',
      connectionId: 'conn-1',
      occurredAt: '2026-11-11T10:00:00.000000Z',
    });
  });

  it('reads a call without client state and a numeric connection id', () => {
    const body = fixtureJson('call-initiated-outgoing');
    body.data.payload.client_state = null;
    body.data.payload.connection_id = 1234567890;
    body.data.payload.to = 'sip:911@sip.telnyx.com';
    expect(telnyxOutboundStart(body)).toMatchObject({
      clientState: null,
      connectionId: '1234567890',
      to: 'sip:911@sip.telnyx.com',
    });
  });

  it('never reads an incoming call, a call without a direction, or another event', () => {
    const incoming = fixtureJson('call-initiated-outgoing');
    incoming.data.payload.direction = 'incoming';
    expect(telnyxOutboundStart(incoming)).toBeNull();
    const noDirection = fixtureJson('call-initiated-outgoing');
    noDirection.data.payload.direction = undefined;
    expect(telnyxOutboundStart(noDirection)).toBeNull();
    expect(telnyxOutboundStart(fixtureJson('call-answered'))).toBeNull();
    expect(telnyxOutboundStart({ data: {} })).toBeNull();
    expect(telnyxOutboundStart(null)).toBeNull();
  });

  it('keeps reading the event when connection_id has an unexpected shape', () => {
    const body = fixtureJson('call-initiated-outgoing');
    body.data.payload.connection_id = { nested: true };
    expect(telnyxOutboundStart(body)?.connectionId).toBeNull();
    expect(callOf(adapter().normalize(body))?.signal).toEqual({ type: 'dialing' });
  });
});

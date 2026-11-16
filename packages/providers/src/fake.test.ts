import { describe, expect, it } from 'vitest';
import { runAdapterContract, runProviderContract } from './contract.test-helpers';
import { buildFakeCallEvent, FakeProvider, fakeOutboundScenario } from './fake';

const enc = new TextEncoder();

runAdapterContract('fake', async (body) => {
  const adapter = new FakeProvider({ webhookSecret: 'test-secret' });
  return {
    adapter,
    headers: new Headers({ 'x-fake-signature': await adapter.signWebhook(body) }),
  };
});

describe('FakeProvider', () => {
  const fake = new FakeProvider({ webhookSecret: 'test-secret' });

  it('verifies its own signature and rejects tampering', async () => {
    const body = JSON.stringify({
      id: 'ev_1',
      type: 'call.answered',
      occurred_at: '2026-11-11T10:00:00Z',
      resource_id: 'fake_call_1',
      payload: {},
    });
    const sig = await fake.signWebhook(body);
    const headers = new Headers({ 'x-fake-signature': sig });
    expect(await fake.verify(headers, enc.encode(body))).toBe(true);
    expect(await fake.verify(headers, enc.encode(body.replace('answered', 'failed')))).toBe(false);
    expect(await fake.verify(new Headers(), enc.encode(body))).toBe(false);
    expect(await fake.verify(new Headers({ 'x-fake-signature': 'zz' }), enc.encode(body))).toBe(
      false,
    );
  });

  it('parse rejects malformed bodies', () => {
    expect(fake.parse(enc.encode('not json'))).toEqual({ ok: false, error: 'invalid_payload' });
    expect(fake.parse(enc.encode('{"id":"x"}'))).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('parse maps a valid body to a ProviderEvent', () => {
    const body = JSON.stringify({
      id: 'ev_1',
      type: 'call.answered',
      occurred_at: '2026-11-11T10:00:00Z',
      resource_id: 'fake_call_1',
      payload: { a: 1 },
    });
    expect(fake.parse(enc.encode(body))).toEqual({
      ok: true,
      value: {
        kind: 'event',
        event: {
          provider: 'fake',
          externalEventId: 'ev_1',
          type: 'call.answered',
          occurredAt: '2026-11-11T10:00:00Z',
          resourceId: 'fake_call_1',
          payload: { a: 1 },
        },
        body: JSON.parse(body),
      },
    });
  });

  it('parse rejects bad timestamps and accepts offsets', () => {
    const base = {
      id: 'ev_1',
      type: 'call.answered',
      occurred_at: '2026-11-11T10:00:00Z',
      resource_id: 'r',
      payload: {},
    };
    const parse = (v: unknown) => fake.parse(enc.encode(JSON.stringify(v)));
    expect(parse({ ...base, occurred_at: 'garbage' })).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
    expect(parse({ ...base, occurred_at: '2026-11-11T10:00:00+02:00' }).ok).toBe(true);
    expect(parse(base).ok).toBe(true);
  });

  it('requires a non-empty webhook secret', () => {
    expect(() => new FakeProvider({ webhookSecret: '' })).toThrow(
      'webhookSecret must be non-empty',
    );
  });

  it('outbound-answered scenario is ordered and normalizes as outbound', () => {
    const events = fake.scenario('outbound-answered', 'fake_call_1');
    expect(events.map((e) => e.type)).toEqual([
      'call.initiated',
      'call.ringing',
      'call.answered',
      'call.completed',
    ]);
    const times = events.map((e) => Date.parse(e.occurredAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(4);
    for (const e of events) {
      const n = fake.normalize({
        id: e.externalEventId,
        type: e.type,
        occurred_at: e.occurredAt,
        resource_id: e.resourceId,
        payload: e.payload,
      });
      expect(n).toMatchObject({
        kind: 'call',
        direction: 'outbound',
        providerCallId: 'fake_call_1',
      });
    }
  });

  it('records calls and messages with per-instance counters', async () => {
    const f = new FakeProvider({ webhookSecret: 's' });
    const call = await f.createCall({
      orgId: 'org_1',
      from: '+12025550100',
      to: '+12025550123',
      idempotencyKey: 'k1',
    });
    expect(call).toEqual({ providerCallId: 'fake_call_1', state: 'queued' });
    expect(f.calls).toHaveLength(1);
    const sms = await f.sendSms({
      orgId: 'org_1',
      from: '+12025550100',
      to: '+12025550123',
      body: 'hi',
      idempotencyKey: 'k2',
    });
    const wa = await f.sendWhatsApp({
      orgId: 'org_1',
      from: '+12025550100',
      to: '+12025550123',
      body: 'hi',
      idempotencyKey: 'k3',
    });
    expect(sms).toEqual({ providerMessageId: 'fake_msg_1', state: 'queued' });
    expect(wa.providerMessageId).toBe('fake_msg_2');
    expect(f.messages).toHaveLength(2);
    expect(
      await f.fetchUsage({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }),
    ).toEqual([]);
    await expect(f.endCall('fake_call_1')).resolves.toBeUndefined();
    const s = await f.createClientSession({ orgId: 'org_1', userId: 'u' });
    expect(s.token).toBe('fake_token_1');
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.now());
  });
});

const envelope = (type: string, payload: Record<string, unknown>) => ({
  id: 'ev_n',
  type,
  occurred_at: '2026-11-11T10:00:00.000Z',
  resource_id: 'call_9',
  payload,
});

describe('FakeProvider.normalize', () => {
  const fake = new FakeProvider({ webhookSecret: 'test-secret' });
  const out = { direction: 'outgoing', from: '+12025550100', to: '+12025550123' };
  const inc = { direction: 'incoming', from: '+12025550123', to: '+12025550100' };

  it.each([
    ['call.initiated', out, { type: 'dialing' }],
    ['call.initiated', inc, { type: 'ringing' }],
    ['call.ringing', out, { type: 'ringing' }],
    ['call.answered', out, { type: 'answered' }],
    ['call.completed', out, { type: 'hangup', cause: 'normal' }],
    ['call.completed', { ...out, hangup_cause: 'busy' }, { type: 'hangup', cause: 'busy' }],
    ['call.failed', out, { type: 'hangup', cause: 'failed' }],
  ])('%s maps to its signal', (type, payload, signal) => {
    expect(fake.normalize(envelope(type, payload))).toMatchObject({
      kind: 'call',
      provider: 'fake',
      providerCallId: 'call_9',
      signal,
      occurredAt: '2026-11-11T10:00:00.000Z',
    });
  });

  it('maps direction, numbers, client state, billable seconds and org hint', () => {
    expect(
      fake.normalize(
        envelope('call.completed', {
          ...inc,
          client_state: 'cs',
          billable_seconds: 61,
          org_id: 'org_x',
        }),
      ),
    ).toMatchObject({
      direction: 'inbound',
      from: '+12025550123',
      to: '+12025550100',
      clientState: 'cs',
      billableSeconds: 61,
      orgHint: 'org_x',
    });
    expect(fake.normalize(envelope('call.completed', { ...out, org_id: 'org_x' }))).toMatchObject({
      orgHint: null,
      clientState: null,
      billableSeconds: null,
    });
  });

  it('call.voicemail hangs up as no_answer and carries the voicemail', () => {
    expect(
      fake.normalize(
        envelope('call.voicemail', { ...inc, duration_seconds: 12, transcript: 'hello' }),
      ),
    ).toMatchObject({
      signal: { type: 'hangup', cause: 'no_answer' },
      voicemail: { durationSeconds: 12, transcript: 'hello' },
    });
    expect(
      fake.normalize(envelope('call.voicemail', { ...inc, duration_seconds: 3 })),
    ).toMatchObject({ voicemail: { durationSeconds: 3, transcript: null } });
  });

  it('message events normalize with their validated payload', () => {
    const payload = { channel: 'sms', from: '+12025550123', to: 'sandbox:ab', body: 'Hi' };
    expect(fake.normalize(envelope('message.received', payload))).toMatchObject({
      kind: 'message',
      provider: 'fake',
      event: { type: 'message.received', resourceId: 'call_9', payload },
      payload,
    });
  });

  it('invalid message payloads and unusable payloads normalize to null', () => {
    expect(fake.normalize(envelope('message.sent', {}))).toBeNull();
    expect(
      fake.normalize(envelope('message.received', { channel: 'sms', from: 'a', to: 'b' })),
    ).toBeNull();
    expect(fake.normalize(envelope('call.answered', {}))).toBeNull();
    expect(fake.normalize('nope')).toBeNull();
  });
});

describe('fakeOutboundScenario', () => {
  it('chooses by the last four digits', () => {
    expect(fakeOutboundScenario('+12025550190')).toBe('busy');
    expect(fakeOutboundScenario('+12025550191')).toBe('no_answer');
    expect(fakeOutboundScenario('+12025550192')).toBe('failed');
    expect(fakeOutboundScenario('+12025550123')).toBe('answered');
  });
});

describe('buildFakeCallEvent', () => {
  it('builds a body that parses and normalizes', () => {
    const { body } = buildFakeCallEvent({
      type: 'call.answered',
      providerCallId: 'fake_call_7',
      payload: { direction: 'outgoing', from: '+12025550100', to: '+12025550123' },
    });
    const fake = new FakeProvider({ webhookSecret: 's' });
    const parsed = fake.parse(enc.encode(body));
    expect(parsed.ok && parsed.value.kind === 'event' && parsed.value.event.resourceId).toBe(
      'fake_call_7',
    );
    expect(fake.normalize(JSON.parse(body))).toMatchObject({ providerCallId: 'fake_call_7' });
  });
});

describe('FakeProvider numbers, balance and usage', () => {
  it('lists the three fake numbers', async () => {
    const f = new FakeProvider({ webhookSecret: 's' });
    expect(await f.listNumbers()).toEqual([
      {
        providerNumberId: 'fake_num_100',
        e164: '+12025550100',
        status: 'active',
        capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
        tenDlc: 'registered',
        whatsapp: 'none',
      },
      {
        providerNumberId: 'fake_num_101',
        e164: '+12025550101',
        status: 'active',
        capabilities: { voice: true, sms: false, mms: false, whatsapp: false },
        tenDlc: 'not_required',
        whatsapp: 'none',
      },
      {
        providerNumberId: 'fake_num_102',
        e164: '+12025550102',
        status: 'active',
        capabilities: { voice: false, sms: true, mms: true, whatsapp: true },
        tenDlc: 'pending',
        whatsapp: 'pending',
      },
    ]);
  });

  it('reports the default and a custom balance', async () => {
    expect(await new FakeProvider({ webhookSecret: 's' }).fetchBalance()).toEqual({
      balanceMicros: 50_000_000,
      currency: 'USD',
    });
    const custom = new FakeProvider({ webhookSecret: 's', balanceMicros: 1_500_000 });
    expect((await custom.fetchBalance()).balanceMicros).toBe(1_500_000);
  });

  it('filters usage to from <= occurredAt < to', async () => {
    const u = (occurredAt: string, providerRef: string) => ({
      service: 'voice' as const,
      quantity: 6,
      unit: 'second',
      costMicros: 1000,
      occurredAt,
      providerRef,
    });
    const f = new FakeProvider({
      webhookSecret: 's',
      usage: [
        u('2026-11-10T23:59:59Z', 'a'),
        u('2026-11-11T00:00:00Z', 'b'),
        u('2026-11-11T12:00:00Z', 'c'),
        u('2026-11-12T00:00:00Z', 'd'),
      ],
    });
    const got = await f.fetchUsage({ from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z' });
    expect(got.map((x) => x.providerRef)).toEqual(['b', 'c']);
  });
});

describe('FakeProvider number purchase', () => {
  const fake = new FakeProvider({ webhookSecret: 'test-secret' });

  it('searches 202 deterministically with the fixed price and capabilities', async () => {
    const found = await fake.searchAvailableNumbers({
      country: 'US',
      areaCode: '202',
      features: ['voice', 'sms'],
    });
    expect(found.map((n) => n.e164)).toEqual(
      Array.from({ length: 10 }, (_, i) => `+1202555015${i}`),
    );
    expect(found[0]).toEqual({
      e164: '+12025550150',
      locality: null,
      region: null,
      capabilities: { voice: true, sms: true, mms: true },
      upfrontMicros: 1_000_000,
      monthlyMicros: 1_000_000,
      currency: 'USD',
    });
  });

  it('returns five numbers for any other area code and honours the limit', async () => {
    const found = await fake.searchAvailableNumbers({
      country: 'US',
      areaCode: '415',
      features: ['voice'],
    });
    expect(found.map((n) => n.e164)).toEqual([
      '+14155550150',
      '+14155550151',
      '+14155550152',
      '+14155550153',
      '+14155550154',
    ]);
    const two = await fake.searchAvailableNumbers({
      country: 'US',
      areaCode: '415',
      features: [],
      limit: 2,
    });
    expect(two).toHaveLength(2);
  });

  it('quotes a listed number and answers null for an unlisted one', async () => {
    expect((await fake.quoteNumber('+12025550153'))?.e164).toBe('+12025550153');
    expect((await fake.quoteNumber('+14155550154'))?.upfrontMicros).toBe(1_000_000);
    expect(await fake.quoteNumber('+14155550159')).toBeNull();
    expect(await fake.quoteNumber('+14155550155')).toBeNull();
    await expect(fake.quoteNumber('not-a-number')).rejects.toThrow(
      new RangeError('invalid_number'),
    );
  });

  it('orders successfully, and fails a number ending 0159', async () => {
    const ok = await fake.orderNumber({ e164: '+12025550150', connectionId: null });
    expect(ok).toEqual({
      providerOrderId: expect.stringMatching(/^fake_order_/),
      status: 'completed',
      e164: '+12025550150',
    });
    const bad = await fake.orderNumber({ e164: '+12025550159', connectionId: 'c' });
    expect(bad.status).toBe('failed');
    expect(bad.e164).toBe('+12025550159');
  });

  it('fails an order for a number outside its listing, and rejects invalid input', async () => {
    const gone = await fake.orderNumber({ e164: '+12025550199', connectionId: null });
    expect(gone.status).toBe('failed');
    await expect(fake.orderNumber({ e164: '+1abc', connectionId: null })).rejects.toThrow(
      new RangeError('invalid_number'),
    );
    for (const q of [
      { areaCode: '1x2' },
      { areaCode: '055' },
      { region: 'dc' },
      { locality: '' },
    ]) {
      await expect(
        fake.searchAvailableNumbers({ country: 'US', features: [], ...q }),
      ).rejects.toThrow(new RangeError('invalid_search'));
    }
  });

  it('clamps the limit to an integer between 1 and 20', async () => {
    const n = (limit: number) =>
      fake.searchAvailableNumbers({ country: 'US', features: [], limit }).then((r) => r.length);
    expect(await n(0)).toBe(1);
    expect(await n(-3)).toBe(1);
    expect(await n(2.9)).toBe(2);
    expect(await n(99)).toBe(10);
    expect(await n(Number.NaN)).toBe(10);
  });

  it('treats an already ordered number as unavailable to quote and order', async () => {
    const f = new FakeProvider({ webhookSecret: 's', ordered: ['+12025550150'] });
    expect(await f.quoteNumber('+12025550150')).toBeNull();
    expect(await f.quoteNumber('+12025550151')).not.toBeNull();
    const order = await f.orderNumber({ e164: '+12025550150', connectionId: null });
    expect(order.status).toBe('failed');
  });

  it('lists ordered numbers as active, fully capable and 10DLC none', async () => {
    const f = new FakeProvider({ webhookSecret: 's', ordered: ['+12025550150'] });
    const listed = await f.listNumbers();
    expect(listed).toHaveLength(4);
    expect(listed[3]).toMatchObject({
      e164: '+12025550150',
      status: 'active',
      capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
      tenDlc: 'none',
      whatsapp: 'none',
    });
    expect(listed[3]?.providerNumberId).toBeTruthy();
  });
});

runProviderContract('fake', () => ({
  provider: new FakeProvider({
    webhookSecret: 'contract-secret',
    usage: [
      {
        service: 'voice',
        quantity: 61,
        unit: 'second',
        costMicros: 20_000,
        occurredAt: '2026-11-11T10:00:00.000Z',
        providerRef: 'fake_call_contract',
      },
    ],
  }),
  search: { country: 'US', areaCode: '202', features: ['voice'], limit: 5 },
  unlistedE164: '+14155550199',
  period: { from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z' },
  now: Date.now(),
}));

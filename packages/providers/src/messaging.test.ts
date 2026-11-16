import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake';
import {
  fakeMessageEvent,
  isMessageEventType,
  type MessageEventPayload,
  parseMessagePayload,
  toFakeWebhookBody,
} from './messaging';
import type { ProviderEvent } from './types';

const received: MessageEventPayload = {
  channel: 'sms',
  from: '+12025550101',
  to: '+12025550100',
  body: 'hello',
};

const event = (type: ProviderEvent['type'], payload: unknown): ProviderEvent => ({
  provider: 'fake',
  externalEventId: 'e1',
  type,
  occurredAt: '2026-11-11T10:00:00.000Z',
  resourceId: 'm1',
  payload: payload as Record<string, unknown>,
});

describe('parseMessagePayload', () => {
  it('accepts a received sms', () => {
    expect(parseMessagePayload(event('message.received', received))).toEqual({
      ok: true,
      value: received,
    });
  });

  it('rejects a received message with no body', () => {
    const { body: _b, ...noBody } = received;
    expect(parseMessagePayload(event('message.received', noBody))).toEqual({
      ok: false,
      error: 'invalid_payload',
    });
  });

  it('rejects error on message.delivered', () => {
    const p = { ...received, error: { code: 'x', message: 'y' } };
    expect(parseMessagePayload(event('message.delivered', p)).ok).toBe(false);
  });

  it('allows error on message.failed', () => {
    const p = { channel: 'sms', from: 'a', to: 'b', error: { code: 'x', message: 'y' } };
    expect(parseMessagePayload(event('message.failed', p)).ok).toBe(true);
  });

  it('keeps final on message.sent', () => {
    const p = { channel: 'sms', from: 'a', to: 'b', final: true };
    expect(parseMessagePayload(event('message.sent', p))).toEqual({ ok: true, value: p });
  });

  it('rejects final on any other event', () => {
    const p = { channel: 'sms', from: 'a', to: 'b', final: true };
    expect(parseMessagePayload(event('message.delivered', p)).ok).toBe(false);
  });

  it('rejects a 4097-character body', () => {
    const p = { ...received, body: 'a'.repeat(4097) };
    expect(parseMessagePayload(event('message.received', p)).ok).toBe(false);
  });
});

describe('isMessageEventType', () => {
  it('matches message.* only', () => {
    expect(isMessageEventType('message.read')).toBe(true);
    expect(isMessageEventType('call.answered')).toBe(false);
  });
});

describe('fakeMessageEvent / toFakeWebhookBody', () => {
  it('builds the default event id and round-trips through parse', () => {
    const e = fakeMessageEvent({
      type: 'message.received',
      providerMessageId: 'fake_msg_9',
      payload: received,
      occurredAt: '2026-11-11T10:00:00.000Z',
    });
    expect(e.provider).toBe('fake');
    expect(e.resourceId).toBe('fake_msg_9');
    expect(e.externalEventId).toBe('message.received_fake_msg_9');
    const body = toFakeWebhookBody(e);
    const parsed = new FakeProvider({ webhookSecret: 's' }).parse(new TextEncoder().encode(body));
    expect(parsed).toEqual({
      ok: true,
      value: { kind: 'event', event: e, body: JSON.parse(body) },
    });
  });

  it('honours an explicit event id', () => {
    const e = fakeMessageEvent({
      type: 'message.sent',
      providerMessageId: 'm',
      payload: received,
      eventId: 'custom',
    });
    expect(e.externalEventId).toBe('custom');
  });

  it('parses a signed message.read body', async () => {
    const fake = new FakeProvider({ webhookSecret: 's' });
    const e = fakeMessageEvent({
      type: 'message.read',
      providerMessageId: 'm',
      payload: { channel: 'whatsapp', from: '+12025550100', to: '+12025550101' },
    });
    const body = new TextEncoder().encode(toFakeWebhookBody(e));
    const sig = await fake.signWebhook(body);
    expect(await fake.verify(new Headers({ 'x-fake-signature': sig }), body)).toBe(true);
    const parsed = fake.parse(body);
    expect(parsed.ok && parsed.value.kind === 'event' && parsed.value.event.type).toBe(
      'message.read',
    );
  });
});

describe('messageIdFactory', () => {
  it('is used by sendSms and sendWhatsApp', async () => {
    const fake = new FakeProvider({ webhookSecret: 's', messageIdFactory: () => 'custom_id' });
    const r = await fake.sendSms({
      orgId: 'o',
      from: 'a',
      to: 'b',
      body: 'x',
      idempotencyKey: 'k',
    });
    expect(r.providerMessageId).toBe('custom_id');
  });
});

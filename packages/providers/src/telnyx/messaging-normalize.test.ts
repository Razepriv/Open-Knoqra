import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMessagePayload } from '../messaging';
import { normalizeTelnyxMessage, TELNYX_MESSAGE_EVENT_TYPES } from './messaging-normalize';

const OUR = '+12025550100';
const CONTACT = '+12025550123';

type Fixture = { data: { payload: Record<string, unknown> } & Record<string, unknown> };

const fixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(
      new URL(`../../test/fixtures/telnyx/messaging/${name}.json`, import.meta.url),
      'utf8',
    ),
  );

/** A copy of a fixture with some payload fields replaced. */
const withPayload = (name: string, patch: Record<string, unknown>): Fixture => {
  const f = fixture(name);
  return { ...f, data: { ...f.data, payload: { ...f.data.payload, ...patch } } };
};

/** The normalized event also passes M3's own message payload validation. */
const expectValidForM3 = (event: ReturnType<typeof normalizeTelnyxMessage>) => {
  if (event === null) throw new Error('expected an event');
  const parsed = parseMessagePayload({
    provider: 'telnyx',
    externalEventId: event.externalEventId,
    type: event.type,
    occurredAt: event.occurredAt,
    resourceId: event.providerMessageId,
    payload: { ...event.payload },
  });
  expect(parsed.ok).toBe(true);
};

describe('TELNYX_MESSAGE_EVENT_TYPES', () => {
  it('lists the documented message events, including the WhatsApp read event', () => {
    expect(TELNYX_MESSAGE_EVENT_TYPES).toEqual([
      'message.received',
      'message.sent',
      'message.finalized',
      'message.read',
    ]);
  });
});

describe('normalizeTelnyxMessage', () => {
  it('normalizes an inbound SMS', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-sms-received'));
    expect(event).toEqual({
      externalEventId: '00000000-0000-4000-8000-0000000e0001',
      type: 'message.received',
      occurredAt: '2026-11-13T20:16:07.588+00:00',
      providerMessageId: '00000000-0000-4000-8000-0000000b0001',
      payload: { channel: 'sms', from: CONTACT, to: OUR, body: 'Hello from Telnyx!' },
    });
    expectValidForM3(event);
  });

  it('normalizes an inbound WhatsApp text', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-whatsapp-received'));
    expect(event).toEqual({
      externalEventId: '00000000-0000-4000-8000-0000000e0003',
      type: 'message.received',
      occurredAt: '2026-11-13T20:18:07.588+00:00',
      providerMessageId: '00000000-0000-4000-8000-0000000b0003',
      payload: { channel: 'whatsapp', from: CONTACT, to: OUR, body: 'Hi, is my order ready?' },
    });
    expectValidForM3(event);
  });

  it('reads WhatsApp inbound text from payload.text when body.text is absent', () => {
    const body = withPayload('webhook-whatsapp-received', { body: undefined, text: 'Hello' });
    expect(normalizeTelnyxMessage(body)?.payload.body).toBe('Hello');
  });

  it('ignores a WhatsApp inbound message that is not text', () => {
    const body = withPayload('webhook-whatsapp-received', {
      body: { type: 'image', image: { id: 'fake-media-id' } },
    });
    expect(normalizeTelnyxMessage(body)).toBeNull();
  });

  it('ignores a media-only MMS (MMS is out of scope)', () => {
    expect(normalizeTelnyxMessage(fixture('webhook-mms-only-received'))).toBeNull();
  });

  it('ignores an inbound message whose text is only whitespace', () => {
    expect(normalizeTelnyxMessage(withPayload('webhook-sms-received', { text: '  ' }))).toBeNull();
  });

  it('keeps the text of an MMS that has text, as SMS', () => {
    const body = withPayload('webhook-mms-only-received', { text: 'Look at this' });
    expect(normalizeTelnyxMessage(body)?.payload).toEqual({
      channel: 'sms',
      from: CONTACT,
      to: OUR,
      body: 'Look at this',
    });
  });

  it('caps an inbound body at 4096 characters', () => {
    const body = withPayload('webhook-sms-received', { text: 'a'.repeat(5000) });
    const event = normalizeTelnyxMessage(body);
    expect(event?.payload.body).toHaveLength(4096);
    expectValidForM3(event);
  });

  it('normalizes message.sent with our number as from', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-sms-sent'));
    expect(event).toEqual({
      externalEventId: '00000000-0000-4000-8000-0000000e0004',
      type: 'message.sent',
      occurredAt: '2026-11-13T21:32:13.596+00:00',
      providerMessageId: '00000000-0000-4000-8000-0000000a0001',
      payload: { channel: 'sms', from: OUR, to: CONTACT },
    });
    expectValidForM3(event);
  });

  it('maps finalized delivered to message.delivered', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-sms-finalized-delivered'));
    expect(event).toMatchObject({
      type: 'message.delivered',
      externalEventId: '00000000-0000-4000-8000-0000000e0005',
      providerMessageId: '00000000-0000-4000-8000-0000000a0001',
      payload: { channel: 'sms', from: OUR, to: CONTACT },
    });
    expectValidForM3(event);
  });

  it('maps finalized delivery_failed to message.failed with the carrier code and title', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-sms-finalized-failed'));
    expect(event).toMatchObject({
      type: 'message.failed',
      payload: {
        channel: 'sms',
        from: OUR,
        to: CONTACT,
        error: { code: '40001', message: 'Not routable' },
      },
    });
    expect(JSON.stringify(event)).not.toContain('is not routable');
    expectValidForM3(event);
  });

  it('maps sending_failed to message.failed, with defaults when errors is empty', () => {
    const body = withPayload('webhook-sms-finalized-delivered', {
      to: [{ phone_number: CONTACT, status: 'sending_failed' }],
      errors: [],
    });
    const event = normalizeTelnyxMessage(body);
    expect(event?.type).toBe('message.failed');
    expect(event?.payload.error).toEqual({
      code: 'delivery_failed',
      message: 'The message could not be delivered.',
    });
    expectValidForM3(event);
  });

  it('caps the failure title at 300 characters and drops an unsafe code', () => {
    const body = withPayload('webhook-sms-finalized-failed', {
      errors: [{ code: `${CONTACT} bad`, title: 'x'.repeat(400) }],
    });
    const error = normalizeTelnyxMessage(body)?.payload.error;
    expect(error?.code).toBe('delivery_failed');
    expect(error?.message).toHaveLength(300);
  });

  it('accepts a numeric errors[].code', () => {
    const body = withPayload('webhook-sms-finalized-failed', {
      errors: [{ code: 40012, title: 'Invalid destination number' }],
    });
    expect(normalizeTelnyxMessage(body)?.payload.error?.code).toBe('40012');
  });

  it('maps WhatsApp undeliverable to message.failed with the fixed code undeliverable', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-whatsapp-finalized-undeliverable'));
    expect(event).toMatchObject({
      type: 'message.failed',
      externalEventId: '00000000-0000-4000-8000-0000000e000c',
      providerMessageId: '00000000-0000-4000-8000-0000000a0002',
      payload: {
        channel: 'whatsapp',
        from: OUR,
        to: CONTACT,
        error: { code: 'undeliverable', message: 'Undeliverable' },
      },
    });
    expect(JSON.stringify(event)).not.toContain('Meta could not deliver');
    expectValidForM3(event);
  });

  it('gives undeliverable the default message when errors is empty, and caps the title', () => {
    const empty = withPayload('webhook-whatsapp-finalized-undeliverable', { errors: [] });
    expect(normalizeTelnyxMessage(empty)?.payload.error).toEqual({
      code: 'undeliverable',
      message: 'The message could not be delivered.',
    });
    const long = withPayload('webhook-whatsapp-finalized-undeliverable', {
      errors: [{ code: '40008', title: 'y'.repeat(400) }],
    });
    const error = normalizeTelnyxMessage(long)?.payload.error;
    expect(error?.code).toBe('undeliverable');
    expect(error?.message).toHaveLength(300);
  });

  it('uses to[0] of a multi-recipient finalized event (one Telnyx message id per recipient)', () => {
    const body = withPayload('webhook-sms-finalized-delivered', {
      to: [
        { phone_number: CONTACT, status: 'delivered' },
        { phone_number: '+12025550124', status: 'delivery_failed' },
      ],
    });
    const event = normalizeTelnyxMessage(body);
    expect(event).toMatchObject({
      type: 'message.delivered',
      providerMessageId: '00000000-0000-4000-8000-0000000a0001',
      payload: { channel: 'sms', from: OUR, to: CONTACT },
    });
    expect(event?.payload.error).toBeUndefined();
  });

  it('maps finalized delivery_unconfirmed to a final message.sent (ruling AS)', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-sms-finalized-unconfirmed'));
    expect(event).toMatchObject({
      type: 'message.sent',
      payload: { channel: 'sms', from: OUR, to: CONTACT, final: true },
    });
    expect(event?.payload.error).toBeUndefined();
    expectValidForM3(event);
  });

  it('does not mark the first message.sent final', () => {
    expect(normalizeTelnyxMessage(fixture('webhook-sms-sent'))?.payload.final).toBeUndefined();
  });

  it('maps a WhatsApp finalized read to message.read', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-whatsapp-finalized-read'));
    expect(event).toMatchObject({
      type: 'message.read',
      externalEventId: '00000000-0000-4000-8000-0000000e0009',
      providerMessageId: '00000000-0000-4000-8000-0000000a0002',
      payload: { channel: 'whatsapp', from: OUR, to: CONTACT },
    });
    expectValidForM3(event);
  });

  it('maps the WhatsApp message.read event to message.read', () => {
    const event = normalizeTelnyxMessage(fixture('webhook-whatsapp-read'));
    expect(event).toEqual({
      externalEventId: '00000000-0000-4000-8000-0000000e000a',
      type: 'message.read',
      occurredAt: '2026-11-13T21:41:00.000+00:00',
      providerMessageId: '00000000-0000-4000-8000-0000000a0002',
      payload: { channel: 'whatsapp', from: OUR, to: CONTACT },
    });
  });

  it('returns null for a finalized status it does not map', () => {
    expect(normalizeTelnyxMessage(fixture('webhook-sms-finalized-unknown-status'))).toBeNull();
  });

  it('returns null for an event type outside the list', () => {
    expect(normalizeTelnyxMessage(fixture('webhook-unrelated-event'))).toBeNull();
  });

  it('returns null for a message type it does not handle', () => {
    expect(normalizeTelnyxMessage(withPayload('webhook-sms-received', { type: 'RCS' }))).toBeNull();
  });

  it('returns null when the direction contradicts the event', () => {
    const body = withPayload('webhook-sms-received', { direction: 'outbound' });
    expect(normalizeTelnyxMessage(body)).toBeNull();
  });

  it('returns null for malformed input', () => {
    const missingTo = withPayload('webhook-sms-received', { to: [] });
    const badDate = { data: { ...fixture('webhook-sms-sent').data, occurred_at: 'yesterday' } };
    const noId = withPayload('webhook-sms-sent', { id: '' });
    for (const body of [
      null,
      undefined,
      'message.received',
      42,
      [],
      {},
      { data: null },
      { data: { event_type: 'message.received' } },
      missingTo,
      badDate,
      noId,
    ]) {
      expect(normalizeTelnyxMessage(body)).toBeNull();
    }
  });
});

describe('normalizeTelnyxMessage with the live WhatsApp shape', () => {
  // Telnyx's inbound WhatsApp webhook as delivered live on 2026-11-16: `to` is a plain string and
  // the text is at body.text.body. Before the fix the whole message was dropped as malformed.
  const live = {
    data: {
      id: 'evt-wa-1',
      event_type: 'message.received',
      occurred_at: '2026-11-15T19:52:19.000Z',
      record_type: 'event',
      payload: {
        autoresponse_type: null,
        body: {
          foreign_id: 'wamid.example',
          from: CONTACT,
          from_user_id: 'US.123',
          id: 'msg-wa-1',
          text: { body: 'Hi' },
          timestamp: '1794772335',
          type: 'text',
        },
        completed_at: null,
        cost: { amount: null, currency: null },
        cost_breakdown: {},
        direction: 'inbound',
        errors: [],
        from: { carrier: '', line_type: '', phone_number: CONTACT },
        id: 'msg-wa-1',
        is_spam: false,
        messaging_profile_id: 'profile-1',
        received_at: '2026-11-15T19:52:19.000Z',
        record_type: 'message',
        sent_at: null,
        tags: [],
        to: OUR,
        type: 'WHATSAPP',
      },
    },
  };

  it('normalizes the inbound WhatsApp text with a string `to`', () => {
    const event = normalizeTelnyxMessage(live);
    expect(event).toMatchObject({
      type: 'message.received',
      providerMessageId: 'msg-wa-1',
      payload: { channel: 'whatsapp', from: CONTACT, to: OUR, body: 'Hi' },
    });
    expectValidForM3(event);
  });

  it('accepts a plain-string `from` too', () => {
    const event = normalizeTelnyxMessage({
      data: { ...live.data, payload: { ...live.data.payload, from: CONTACT } },
    });
    expect(event?.payload).toMatchObject({ from: CONTACT, to: OUR });
  });

  it('reads a WhatsApp receipt status from the top level when `to` is a string', () => {
    const event = normalizeTelnyxMessage({
      data: {
        ...live.data,
        id: 'evt-wa-2',
        event_type: 'message.finalized',
        payload: {
          ...live.data.payload,
          direction: 'outbound',
          from: OUR,
          to: CONTACT,
          status: 'delivered',
        },
      },
    });
    expect(event).toMatchObject({ type: 'message.delivered', payload: { channel: 'whatsapp' } });
  });
});

import type { MessagingChannel } from '@knoqra/core';
import { z } from 'zod';
import type { MessageEventPayload } from '../messaging';
import type { ProviderEventType } from '../types';
import { SAFE_TELNYX_CODE } from './messaging-errors';

/**
 * Telnyx message webhook events. WhatsApp uses the same events as SMS, plus a
 * separate `message.read` when the recipient has read receipts on.
 */
export const TELNYX_MESSAGE_EVENT_TYPES = [
  'message.received',
  'message.sent',
  'message.finalized',
  'message.read',
] as const;
export type TelnyxMessageEventType = (typeof TELNYX_MESSAGE_EVENT_TYPES)[number];

export interface TelnyxMessageEvent {
  externalEventId: string;
  type: ProviderEventType;
  occurredAt: string;
  providerMessageId: string;
  payload: MessageEventPayload;
}

const MAX_BODY = 4096;
const MAX_ERROR_MESSAGE = 300;
const DEFAULT_FAILURE = {
  code: 'delivery_failed',
  message: 'The message could not be delivered.',
} as const;

const envelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1).max(128),
    event_type: z.string(),
    occurred_at: z.iso.datetime({ offset: true }),
    payload: z.unknown(),
  }),
});

const addressSchema = z.string().min(1).max(64);

/**
 * SMS webhooks carry `from: { phone_number }` and `to: [{ phone_number }]`. WhatsApp webhooks carry
 * `to` as a plain E.164 string (seen live 2026-11-16), and may do the same for `from`. Accept both
 * forms, or every inbound WhatsApp message is dropped as malformed.
 */
const partySchema = z.union([z.object({ phone_number: addressSchema }), addressSchema]);
const partyAddress = (party: z.infer<typeof partySchema>): string =>
  typeof party === 'string' ? party : party.phone_number;

const payloadSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.string(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  from: partySchema,
  to: z.union([
    z.array(z.object({ phone_number: addressSchema, status: z.string().optional() })).min(1),
    addressSchema,
  ]),
  status: z.string().optional(),
  text: z.string().nullable().optional(),
  /** WhatsApp content. Inbound text is at `body.text.body`. */
  body: z.object({ text: z.object({ body: z.string() }).optional() }).optional(),
  errors: z.array(z.unknown()).optional(),
});
type TelnyxPayload = z.infer<typeof payloadSchema>;

const errorItemSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  title: z.string().optional(),
});

const isMessageEventType = (type: string): type is TelnyxMessageEventType =>
  (TELNYX_MESSAGE_EVENT_TYPES as readonly string[]).includes(type);

/** `WHATSAPP` is WhatsApp; `SMS` and `MMS` are SMS. Anything else (RCS, ...) is not handled. */
function channelOf(type: string): MessagingChannel | null {
  if (type === 'WHATSAPP') return 'whatsapp';
  if (type === 'SMS' || type === 'MMS') return 'sms';
  return null;
}

/** Truncates to `max` UTF-16 units without splitting a surrogate pair. */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The first `errors[]` entry's code and title. The `detail` is never read: it can echo numbers. */
function failureOf(errors: unknown[] | undefined): { code: string; message: string } {
  const first = errorItemSchema.safeParse(errors?.[0]);
  if (!first.success) return { ...DEFAULT_FAILURE };
  const code = first.data.code === undefined ? '' : String(first.data.code);
  const title = first.data.title?.trim() ?? '';
  return {
    code: SAFE_TELNYX_CODE.test(code) ? code : DEFAULT_FAILURE.code,
    message: title.length > 0 ? cap(title, MAX_ERROR_MESSAGE) : DEFAULT_FAILURE.message,
  };
}

function inboundText(payload: TelnyxPayload, channel: MessagingChannel): string | null {
  const text = channel === 'whatsapp' ? (payload.body?.text?.body ?? payload.text) : payload.text;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return cap(text, MAX_BODY);
}

/** Outbound receipts: which normalized event, if any, a Telnyx event and status mean. */
function receiptOf(
  eventType: Exclude<TelnyxMessageEventType, 'message.received'>,
  payload: TelnyxPayload,
): { type: ProviderEventType; error?: { code: string; message: string }; final?: true } | null {
  if (eventType === 'message.sent') return { type: 'message.sent' };
  if (eventType === 'message.read') return { type: 'message.read' };
  // Telnyx gives each recipient its own message id, so to[0] is this message id's recipient. When
  // `to` is a plain string (WhatsApp), the status, if any, is at the payload's top level.
  const status = typeof payload.to === 'string' ? payload.status : payload.to[0]?.status;
  switch (status) {
    case 'delivered':
      return { type: 'message.delivered' };
    case 'delivery_failed':
    case 'sending_failed':
      return { type: 'message.failed', error: failureOf(payload.errors) };
    case 'delivery_unconfirmed':
      // Final, but no carrier confirmation: the status stays sent and Telnyx bills it (ruling AS).
      return { type: 'message.sent', final: true };
    case 'read':
      return { type: 'message.read' };
    case 'undeliverable': {
      // WhatsApp: the code is fixed; only the first errors[] title is kept.
      const { message } = failureOf(payload.errors);
      return { type: 'message.failed', error: { code: 'undeliverable', message } };
    }
    default:
      return null;
  }
}

/**
 * Turns a Telnyx message webhook body into a message event, or `null` when the
 * body is malformed, the event is not a message event, or it carries nothing
 * M3 tracks (MMS media without text, a non-final status, ...).
 */
export function normalizeTelnyxMessage(body: unknown): TelnyxMessageEvent | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return null;
  const { data } = envelope.data;
  if (!isMessageEventType(data.event_type)) return null;

  const parsed = payloadSchema.safeParse(data.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const channel = channelOf(payload.type);
  if (channel === null) return null;

  const inbound = data.event_type === 'message.received';
  if (payload.direction !== undefined && payload.direction !== (inbound ? 'inbound' : 'outbound')) {
    return null;
  }
  const from = partyAddress(payload.from);
  const to = typeof payload.to === 'string' ? payload.to : payload.to[0]?.phone_number;
  if (to === undefined) return null;
  const base = {
    externalEventId: data.id,
    occurredAt: data.occurred_at,
    providerMessageId: payload.id,
  };

  if (data.event_type === 'message.received') {
    const text = inboundText(payload, channel);
    if (text === null) return null;
    return { ...base, type: 'message.received', payload: { channel, from, to, body: text } };
  }

  const receipt = receiptOf(data.event_type, payload);
  if (receipt === null) return null;
  return {
    ...base,
    type: receipt.type,
    payload: {
      channel,
      from,
      to,
      ...(receipt.error === undefined ? {} : { error: receipt.error }),
      ...(receipt.final === undefined ? {} : { final: receipt.final }),
    },
  };
}

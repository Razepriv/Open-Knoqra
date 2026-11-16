import type { AttachmentKind, MessagingChannel } from '@knoqra/core';
import { z } from 'zod';
import type { InboundMediaPayload, MessageEventPayload } from '../messaging';
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

/**
 * A WhatsApp media object inside `body.<type>` (Telnyx's "Downloading Inbound Media" guide): a
 * Telnyx-hosted `url` normally, or Meta's media `id` when Telnyx could not pre-fetch the file, plus
 * `mime_type` and `sha256`. Meta's per-type extras pass through: `caption` (image, video,
 * document), `filename` (document), `voice` (audio recorded as a voice note), `animated` (sticker).
 */
const mediaObjectSchema = z.object({
  url: z.string().max(2048).optional(),
  id: z.string().min(1).max(256).optional(),
  mime_type: z.string().max(128).optional(),
  sha256: z.string().max(128).optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});
const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

/** WhatsApp content (`payload.body`), which mirrors Meta's message object. */
const whatsappBodySchema = z.object({
  type: z.string().optional(),
  /** Meta's id for the message (the wamid). `body.id` is Telnyx's. */
  foreign_id: z.string().min(1).max(256).optional(),
  text: z.object({ body: z.string() }).optional(),
  context: z
    .object({
      id: z.string().min(1).max(256).optional(),
      message_id: z.string().max(256).optional(),
    })
    .optional(),
  reaction: z
    .object({ message_id: z.string().min(1).max(256), emoji: z.string().max(32).optional() })
    .optional(),
  button: z.object({ text: z.string().optional() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string().optional() }).optional(),
      list_reply: z.object({ title: z.string().optional() }).optional(),
    })
    .optional(),
  image: mediaObjectSchema.optional(),
  audio: mediaObjectSchema.optional(),
  video: mediaObjectSchema.optional(),
  document: mediaObjectSchema.optional(),
  sticker: mediaObjectSchema.optional(),
});
type WhatsAppBody = z.infer<typeof whatsappBodySchema>;

/** MMS-style media (`payload.media[]`), used as a fallback URL for a WhatsApp media object. */
const mmsMediaSchema = z.array(
  z.object({ url: z.string().max(2048).optional(), content_type: z.string().optional() }),
);

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
  body: whatsappBodySchema.optional(),
  media: mmsMediaSchema.optional(),
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

const nonEmpty = (text: string | undefined | null): string | undefined => {
  const trimmed = text?.trim();
  return trimmed ? cap(trimmed, MAX_BODY) : undefined;
};

/** Only an https URL is kept: the consumer downloads it server-side. */
const httpsUrl = (url: string | undefined): string | undefined =>
  url !== undefined && /^https:\/\/[^\s]+$/i.test(url) ? url : undefined;

const DEFAULT_MIME: Record<MediaType, string> = {
  image: 'image/jpeg',
  audio: 'audio/ogg',
  video: 'video/mp4',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

/** `audio` recorded with WhatsApp's voice button is a voice note. */
function kindOf(type: MediaType, media: z.infer<typeof mediaObjectSchema>): AttachmentKind {
  return type === 'audio' && media.voice === true ? 'voice' : type;
}

function inboundMedia(
  type: MediaType,
  body: WhatsAppBody,
  payload: TelnyxPayload,
): { media: InboundMediaPayload; caption?: string } | null {
  const object = body[type];
  if (!object) return null;
  const url = httpsUrl(object.url) ?? httpsUrl(payload.media?.[0]?.url);
  const mediaId = object.id;
  if (url === undefined && mediaId === undefined) return null;
  const media: InboundMediaPayload = {
    kind: kindOf(type, object),
    mimeType: (object.mime_type ?? payload.media?.[0]?.content_type ?? DEFAULT_MIME[type]).slice(
      0,
      128,
    ),
    ...(url === undefined ? {} : { url }),
    ...(mediaId === undefined ? {} : { mediaId }),
    ...(object.sha256 === undefined ? {} : { sha256: object.sha256 }),
    ...(object.filename?.trim() ? { fileName: object.filename.trim().slice(0, 255) } : {}),
  };
  const caption = type === 'audio' || type === 'sticker' ? undefined : nonEmpty(object.caption);
  return { media, ...(caption === undefined ? {} : { caption }) };
}

/** Words for a message type the Inbox cannot show as such (a location, a contact card, ...). */
const OTHER_TYPE_TEXT: Record<string, string> = {
  location: 'Shared a location.',
  contacts: 'Shared a contact card.',
  order: 'Sent an order.',
  unsupported: 'Sent a message WhatsApp could not deliver here.',
};

/**
 * The content of an inbound WhatsApp message: text, a file (with its caption), a reaction, or a
 * plain-words stand-in for other types; null for what the Inbox does not keep (edits, revokes,
 * system notices).
 */
function whatsappContent(
  payload: TelnyxPayload,
): Pick<MessageEventPayload, 'body' | 'media' | 'reaction'> | null {
  const body = payload.body ?? {};
  const type = body.type ?? 'text';
  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const found = inboundMedia(type as MediaType, body, payload);
    if (!found) return null;
    return { media: found.media, ...(found.caption === undefined ? {} : { body: found.caption }) };
  }
  if (type === 'reaction') {
    if (!body.reaction) return null;
    const emoji = body.reaction.emoji?.trim();
    return { reaction: { targetId: body.reaction.message_id, emoji: emoji ? emoji : null } };
  }
  if (type === 'edit' || type === 'revoke' || type === 'system') return null;
  if (type === 'text') {
    const text = inboundText(payload, 'whatsapp');
    return text === null ? null : { body: text };
  }
  const chosen =
    nonEmpty(body.button?.text) ??
    nonEmpty(body.interactive?.button_reply?.title) ??
    nonEmpty(body.interactive?.list_reply?.title) ??
    OTHER_TYPE_TEXT[type] ??
    OTHER_TYPE_TEXT.unsupported;
  return { body: chosen };
}

/** The reply target and the wamid of an inbound WhatsApp message. */
function whatsappRefs(
  payload: TelnyxPayload,
): Pick<MessageEventPayload, 'replyToId' | 'channelMessageId'> {
  const replyToId = payload.body?.context?.id ?? payload.body?.context?.message_id;
  const channelMessageId = payload.body?.foreign_id;
  return {
    ...(replyToId ? { replyToId } : {}),
    ...(channelMessageId ? { channelMessageId } : {}),
  };
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
    if (channel === 'whatsapp') {
      const content = whatsappContent(payload);
      if (content === null) return null;
      return {
        ...base,
        type: 'message.received',
        payload: { channel, from, to, ...content, ...whatsappRefs(payload) },
      };
    }
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

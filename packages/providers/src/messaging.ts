import {
  ATTACHMENT_KINDS,
  type AttachmentKind,
  err,
  MESSAGING_CHANNELS,
  type MessagingChannel,
  ok,
  type Result,
} from '@knoqra/core';
import { z } from 'zod';
import type { ProviderEvent, ProviderEventType } from './types';

/**
 * Normalised payload of a `message.*` provider event.
 * For `message.received`, `to` is our address and `from` is the contact.
 * For receipts, `from` is our address.
 */
export interface MessageEventPayload {
  channel: MessagingChannel;
  from: string;
  to: string;
  body?: string;
  error?: { code: string; message: string };
  /**
   * On `message.sent` only: the provider will report nothing further for this message (Telnyx's
   * final `delivery_unconfirmed`). The status stays `sent`; the message's cost hold is captured.
   */
  final?: boolean;
  /** On `message.received` only: the file the message carries (`body` is then its caption). */
  media?: InboundMediaPayload;
  /**
   * On `message.received` only: the message is a reaction to `targetId` (a channel or provider
   * message id); `emoji` null removes the contact's reaction.
   */
  reaction?: { targetId: string; emoji: string | null };
  /** On `message.received` only: the channel or provider id of the message this one replies to. */
  replyToId?: string;
  /** On `message.received` only: the channel's own id for this message (WhatsApp's wamid). */
  channelMessageId?: string;
}

/** An inbound file: a provider-hosted `url`, or a `mediaId` to download it by (or both). */
export interface InboundMediaPayload {
  kind: AttachmentKind;
  mimeType: string;
  url?: string;
  mediaId?: string;
  sha256?: string;
  fileName?: string;
}

const idSchema = z.string().min(1).max(256);
const mediaSchema = z.object({
  kind: z.enum(ATTACHMENT_KINDS),
  mimeType: z.string().min(1).max(128),
  url: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
  mediaId: idSchema.optional(),
  sha256: z.string().max(128).optional(),
  fileName: z.string().max(255).optional(),
});

const payloadSchema = z.object({
  channel: z.enum(MESSAGING_CHANNELS),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  body: z.string().min(1).max(4096).optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(300) }).optional(),
  final: z.boolean().optional(),
  media: mediaSchema.optional(),
  reaction: z
    .object({ targetId: idSchema, emoji: z.string().min(1).max(32).nullable() })
    .optional(),
  replyToId: idSchema.optional(),
  channelMessageId: idSchema.optional(),
});

const RECEIVED_ONLY = ['media', 'reaction', 'replyToId', 'channelMessageId'] as const;

export const isMessageEventType = (type: string): boolean => type.startsWith('message.');

export function parseMessagePayload(
  event: ProviderEvent,
): Result<MessageEventPayload, 'invalid_payload'> {
  const parsed = payloadSchema.safeParse(event.payload);
  if (!parsed.success) return err('invalid_payload');
  const p = parsed.data;
  const received = event.type === 'message.received';
  if (received && p.body === undefined && p.media === undefined && p.reaction === undefined) {
    return err('invalid_payload');
  }
  if (!received && RECEIVED_ONLY.some((key) => p[key] !== undefined)) return err('invalid_payload');
  if (p.media !== undefined && p.media.url === undefined && p.media.mediaId === undefined) {
    return err('invalid_payload');
  }
  if (p.error !== undefined && event.type !== 'message.failed') return err('invalid_payload');
  if (p.final !== undefined && event.type !== 'message.sent') return err('invalid_payload');
  return ok(p);
}

export function fakeMessageEvent(input: {
  type: ProviderEventType;
  providerMessageId: string;
  payload: MessageEventPayload;
  occurredAt?: string;
  eventId?: string;
}): ProviderEvent {
  return {
    provider: 'fake',
    externalEventId: input.eventId ?? `${input.type}_${input.providerMessageId}`,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    resourceId: input.providerMessageId,
    payload: { ...input.payload },
  };
}

/** The fake provider's webhook body format. */
export function toFakeWebhookBody(event: ProviderEvent): string {
  return JSON.stringify({
    id: event.externalEventId,
    type: event.type,
    occurred_at: event.occurredAt,
    resource_id: event.resourceId,
    payload: event.payload,
  });
}

import { err, MESSAGING_CHANNELS, type MessagingChannel, ok, type Result } from '@knoqra/core';
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
}

const payloadSchema = z.object({
  channel: z.enum(MESSAGING_CHANNELS),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  body: z.string().min(1).max(4096).optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(300) }).optional(),
  final: z.boolean().optional(),
});

export const isMessageEventType = (type: string): boolean => type.startsWith('message.');

export function parseMessagePayload(
  event: ProviderEvent,
): Result<MessageEventPayload, 'invalid_payload'> {
  const parsed = payloadSchema.safeParse(event.payload);
  if (!parsed.success) return err('invalid_payload');
  const p = parsed.data;
  if (event.type === 'message.received' && p.body === undefined) return err('invalid_payload');
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

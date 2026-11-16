import { type CallSignal, HANGUP_CAUSES, type HangupCause } from '@knoqra/core';
import { z } from 'zod';
import type { NormalizedEvent } from '../events';
import { base64ToUtf8 } from './base64';

export const TELNYX_PROVIDER = 'telnyx';

/** Telnyx event types this adapter models. Everything else is ignored. */
export const MODELED_EVENT_TYPES = [
  'call.initiated',
  'call.answered',
  'call.hangup',
  'call.machine.detection.ended',
] as const;

export const envelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    event_type: z.string().min(1),
    occurred_at: z.iso.datetime({ offset: true }),
    payload: z.record(z.string(), z.unknown()),
  }),
});

/**
 * Telnyx sends `null` for a field it has no value for: an inbound call carries
 * `"client_state": null` (only calls we place set it), and other fields can be null too. Treat
 * null exactly like a missing field, or every inbound call event is refused as invalid.
 */
const optional = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

const payloadSchema = z.object({
  call_control_id: z.string().min(1),
  client_state: optional(z.string()),
  direction: optional(z.enum(['incoming', 'outgoing'])),
  from: optional(z.string().min(1)),
  to: optional(z.string().min(1)),
  hangup_cause: optional(z.string()),
  start_time: optional(z.iso.datetime({ offset: true })),
  end_time: optional(z.iso.datetime({ offset: true })),
});

export type TelnyxPayload = z.infer<typeof payloadSchema>;

export const parseCallPayload = (payload: unknown): TelnyxPayload | null => {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
};

const CAUSE_MAP: Record<string, HangupCause> = {
  normal_clearing: 'normal',
  user_busy: 'busy',
  timeout: 'no_answer',
  no_answer: 'no_answer',
  call_rejected: 'rejected',
  originator_cancel: 'canceled',
};

export const mapHangupCause = (cause: string | undefined): HangupCause => {
  const mapped = cause === undefined ? undefined : CAUSE_MAP[cause];
  return mapped !== undefined && HANGUP_CAUSES.includes(mapped) ? mapped : 'failed';
};

const signalFor = (
  eventType: string,
  direction: 'inbound' | 'outbound',
  cause: HangupCause,
): CallSignal | null => {
  switch (eventType) {
    case 'call.initiated':
      return { type: direction === 'outbound' ? 'dialing' : 'ringing' };
    case 'call.answered':
      return { type: 'answered' };
    case 'call.hangup':
      return { type: 'hangup', cause };
    default:
      return null;
  }
};

/**
 * `body` is the stored parsed webhook JSON. Returns null when there is nothing to apply.
 *
 * `billableSeconds` is always null: this normalizer is stateless and cannot know whether the call
 * was answered, and Telnyx's `start_time` is when the call started, not when it was answered. The
 * API's call handler bills from its own answered_at to ended_at.
 *
 * A `call.hangup` missing from/to still normalizes (empty string for the missing party) so the
 * terminal signal is never lost. Other event types need both parties and return null without them.
 * A missing direction defaults to 'outbound'; the handler ignores direction on hangup for
 * existing calls.
 */
export function normalizeTelnyx(body: unknown): NormalizedEvent | null {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return null;
  const { event_type: eventType, occurred_at: occurredAt } = envelope.data.data;
  const p = parseCallPayload(envelope.data.data.payload);
  if (p === null) return null;
  const isHangup = eventType === 'call.hangup';
  if (!isHangup && (p.from === undefined || p.to === undefined)) return null;
  const direction = p.direction === 'incoming' ? 'inbound' : 'outbound';
  const cause = mapHangupCause(p.hangup_cause);
  const signal = signalFor(eventType, direction, cause);
  if (signal === null) return null;
  return {
    kind: 'call',
    provider: TELNYX_PROVIDER,
    providerCallId: p.call_control_id,
    clientState: p.client_state === undefined ? null : base64ToUtf8(p.client_state),
    signal,
    direction,
    from: p.from ?? '',
    to: p.to ?? '',
    occurredAt,
    billableSeconds: null,
    voicemail: null,
    orgHint: null,
  };
}

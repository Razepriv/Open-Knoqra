/**
 * What the provider-events queue carries. One queue, two kinds of message: a stored provider event
 * to apply, and a mid-call meter step (events/call-meter.ts) sent with a delay so it arrives when
 * the call's paid time is about to run out.
 */

/** A raw provider event stored by the webhook route, to normalize and apply. */
export type ProviderEventMessage = { rawEventId: string };

/** `extend`: try to hold more minutes. `cutoff`: try once more, else end the call. */
export type CallMeterStep = 'extend' | 'cutoff';

/**
 * One meter step for one call. `paidMinutes` is the call's paid minutes when the step was planned:
 * a step whose call has moved on (extended since, or ended) does nothing, so a late or repeated
 * delivery is harmless.
 */
export interface CallMeterMessage {
  kind: 'call.meter';
  step: CallMeterStep;
  orgId: string;
  callId: string;
  paidMinutes: number;
}

export type QueueMessage = ProviderEventMessage | CallMeterMessage;

export function isCallMeterMessage(body: unknown): body is CallMeterMessage {
  if (typeof body !== 'object' || body === null) return false;
  const m = body as Record<string, unknown>;
  return (
    m.kind === 'call.meter' &&
    (m.step === 'extend' || m.step === 'cutoff') &&
    typeof m.orgId === 'string' &&
    m.orgId !== '' &&
    typeof m.callId === 'string' &&
    m.callId !== '' &&
    typeof m.paidMinutes === 'number' &&
    Number.isSafeInteger(m.paidMinutes) &&
    m.paidMinutes > 0
  );
}

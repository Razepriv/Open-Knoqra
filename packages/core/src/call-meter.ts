import { CALL_RESERVE_MINUTES } from './ledger';
import { evaluateSpend } from './spend';

/**
 * Mid-call metering. A call's holds cover a whole number of billed minutes from the answer (its
 * paid minutes): 10 when it starts, more each time a hold is added mid-call. Shortly before the
 * paid time runs out the API tries to hold another block; when the wallet or the monthly stop cap
 * cannot cover even one more minute, the caller is warned and the call is ended just before the
 * paid time is used up, so a call never costs more than was held for it.
 */

/** The extension is tried this long before the paid time runs out ("minute 9 of 10"). */
export const CALL_EXTEND_LEAD_SECONDS = 60;

/** A call that cannot be extended is hung up this long before its paid time runs out. */
export const CALL_CUTOFF_MARGIN_SECONDS = 10;

/** The most minutes one extension holds: the same block as the hold at the start. */
export const CALL_EXTEND_MAX_MINUTES = CALL_RESERVE_MINUTES;

/**
 * Why a call was cut: the wallet could not pay for one more minute, the next minute would pass the
 * monthly stop cap, or the call ran past the minutes held for it before a hold could be added (the
 * backstop, when KNOQRA's own timer missed).
 */
export const CALL_CUTOFF_REASONS = ['insufficient_funds', 'stop_cap', 'paid_time_over'] as const;
export type CallCutoffReason = (typeof CALL_CUTOFF_REASONS)[number];

/** The cut-off reasons a refused extension gives. */
export type SpendCutoffReason = Exclude<CallCutoffReason, 'paid_time_over'>;

/** The hangup cause stored on a call KNOQRA ended because it could not be paid for. */
export const CUT_OFF_HANGUP_CAUSE = 'cut_off';

export interface ExtensionInput {
  availableMicros: number;
  periodSpendMicros: number;
  heldMicros: number;
  warnCapMicros: number | null;
  stopCapMicros: number | null;
  /** What one more billed minute costs: the call's price plus the platform fee. */
  perMinuteMicros: number;
}

export type ExtensionPlan =
  | { kind: 'extend'; minutes: number; amountMicros: number }
  | { kind: 'refuse'; reason: SpendCutoffReason };

/**
 * The largest whole number of minutes, at most one block, that the spend rules allow holding now
 * (the same `evaluateSpend` that authorizes a call, so a warn cap never cuts a call). Refused with
 * the reason one more minute would be stopped when not even one fits.
 */
export function planCallExtension(input: ExtensionInput): ExtensionPlan {
  if (!Number.isSafeInteger(input.perMinuteMicros) || input.perMinuteMicros <= 0) {
    throw new RangeError(
      `perMinuteMicros must be a positive integer, got ${input.perMinuteMicros}`,
    );
  }
  const decide = (minutes: number) =>
    evaluateSpend({
      availableMicros: input.availableMicros,
      periodSpendMicros: input.periodSpendMicros,
      heldMicros: input.heldMicros,
      requestMicros: minutes * input.perMinuteMicros,
      warnCapMicros: input.warnCapMicros,
      stopCapMicros: input.stopCapMicros,
    });
  for (let minutes = CALL_EXTEND_MAX_MINUTES; minutes >= 1; minutes--) {
    if (decide(minutes).outcome !== 'stop') {
      return { kind: 'extend', minutes, amountMicros: minutes * input.perMinuteMicros };
    }
  }
  const reason = decide(1).reason;
  return { kind: 'refuse', reason: reason === 'stop_cap' ? 'stop_cap' : 'insufficient_funds' };
}

/** When the call's paid time runs out: its answer plus its paid minutes. */
export function paidUntil(answeredAt: Date, paidMinutes: number): Date {
  return new Date(answeredAt.getTime() + paidMinutes * 60_000);
}

/** When to try the next extension. */
export function extendCheckAt(answeredAt: Date, paidMinutes: number): Date {
  return new Date(paidUntil(answeredAt, paidMinutes).getTime() - CALL_EXTEND_LEAD_SECONDS * 1000);
}

/** When a call that cannot be extended is hung up: never before `now`. */
export function cutoffTime(answeredAt: Date, paidMinutes: number, now: Date): Date {
  const at = paidUntil(answeredAt, paidMinutes).getTime() - CALL_CUTOFF_MARGIN_SECONDS * 1000;
  return new Date(Math.max(at, now.getTime()));
}

/** Seconds billed for a call KNOQRA ends itself: answer to `endedAt`, never past the paid time. */
export function cappedBillableSeconds(
  answeredAt: Date | null,
  endedAt: Date,
  paidMinutes: number,
): number | null {
  if (answeredAt === null) return null;
  const elapsed = Math.ceil((endedAt.getTime() - answeredAt.getTime()) / 1000);
  return Math.min(Math.max(0, elapsed), paidMinutes * 60);
}

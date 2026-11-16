import { dollarsToMicros } from './money';
import type { WalletSummary } from './wallet';

export type SpendStatus = WalletSummary['status'];

const AMOUNT_HINT = 'Enter an amount like 5 or 2.50';
const WARN_ABOVE_STOP = 'WARN must be at or below STOP';
/** The API's cap on one credit (MAX_CREDIT_MICROS in apps/api routes/wallet.ts). */
const MAX_CREDIT_MICROS = 1_000_000_000;
const MANAGER_ROLES = new Set(['owner', 'admin']);

export type CapsCheck =
  | { ok: true; value: { warnCapMicros: number | null; stopCapMicros: number | null } }
  | { ok: false; warnError?: string; stopError?: string };

/** A blank cap is off (null); anything else must be a dollar amount. Undefined when invalid. */
function capValue(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return dollarsToMicros(trimmed) ?? undefined;
}

/** The Edit caps form: two dollar fields, blank for off, with WARN at or below STOP. */
export function validateCaps(warnText: string, stopText: string): CapsCheck {
  const warn = capValue(warnText);
  const stop = capValue(stopText);
  if (warn === undefined || stop === undefined) {
    return {
      ok: false,
      ...(warn === undefined ? { warnError: AMOUNT_HINT } : {}),
      ...(stop === undefined ? { stopError: AMOUNT_HINT } : {}),
    };
  }
  if (warn !== null && stop !== null && warn > stop)
    return { ok: false, warnError: WARN_ABOVE_STOP };
  return { ok: true, value: { warnCapMicros: warn, stopCapMicros: stop } };
}

export type CreditCheck =
  | { ok: true; value: { amountMicros: number; note: string } }
  | { ok: false; amountError?: string; noteError?: string };

/** The Add credit form: a positive amount up to $1,000, and a note saying where it came from. */
export function validateCredit(amountText: string, noteText: string): CreditCheck {
  const micros = dollarsToMicros(amountText);
  const note = noteText.trim();
  const amountError =
    micros === null || micros <= 0
      ? AMOUNT_HINT
      : micros > MAX_CREDIT_MICROS
        ? 'Add up to $1,000 at a time.'
        : undefined;
  const noteError = note === '' ? 'Say where this credit came from.' : undefined;
  if (amountError || noteError || micros === null) {
    return {
      ok: false,
      ...(amountError ? { amountError } : {}),
      ...(noteError ? { noteError } : {}),
    };
  }
  return { ok: true, value: { amountMicros: micros, note } };
}

export interface CapMarks {
  /** This month's spend, as a share of the scale (0 to 100). */
  usedPct: number;
  warnPct: number | null;
  stopPct: number | null;
}

type CapInput = Pick<WalletSummary, 'periodSpendMicros' | 'warnCapMicros' | 'stopCapMicros'>;

const pct = (part: number, whole: number): number => Math.min(100, (part / whole) * 100);

/** Where spend, WARN and STOP sit on the cap bar; the bar ends at the highest cap. Null with no caps. */
export function capMarks({
  periodSpendMicros,
  warnCapMicros,
  stopCapMicros,
}: CapInput): CapMarks | null {
  const top = Math.max(warnCapMicros ?? 0, stopCapMicros ?? 0);
  if (top <= 0) return null;
  return {
    usedPct: pct(Math.max(0, periodSpendMicros), top),
    warnPct: warnCapMicros === null ? null : pct(warnCapMicros, top),
    stopPct: stopCapMicros === null ? null : pct(stopCapMicros, top),
  };
}

/**
 * The status dot for the wallet: green, amber near WARN, red when calls are stopped. Pass the
 * wallet's `dialStatus` (the decision for the next call's hold), so it agrees with the dialer.
 */
export function walletTone(status: SpendStatus): 'ok' | 'warn' | 'bad' {
  if (status.outcome === 'stop') return 'bad';
  return status.outcome === 'warn' ? 'warn' : 'ok';
}

/** Why calls are limited right now (from `dialStatus`), or null when nothing is. */
export function walletNotice(status: SpendStatus): string | null {
  if (status.outcome === 'stop') {
    return status.reason === 'insufficient_funds'
      ? 'Balance too low to hold a call.'
      : "Calls are paused: the next call would pass this month's STOP cap.";
  }
  return status.outcome === 'warn' ? "You're near this month's spend cap." : null;
}

/** Owners and admins change caps, add credit and set up voice (the API refuses anyone else). */
export function isOwnerOrAdmin(role: string | undefined): boolean {
  return (role ?? '').split(',').some((r) => MANAGER_ROLES.has(r.trim()));
}

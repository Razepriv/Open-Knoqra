import { callReserveMicros } from './ledger';
import type { SpendDecision } from './spend';

export const PROVIDER_LOW_BALANCE_MICROS = 2_000_000;
export const PROVIDER_SNAPSHOT_STALE_MS = 2 * 3600_000;
export const FAKE_PROVIDER_BALANCE_MICROS = 50_000_000;

export interface ProviderBalanceInput {
  balanceMicros: number | null;
  capturedAt: Date | null;
  now: Date;
}

const OK: SpendDecision = { outcome: 'ok', reason: 'ok' };

/** A missing or stale snapshot has no effect, so a dead poll never blocks calling. */
export function evaluateProviderBalance(input: ProviderBalanceInput): SpendDecision {
  const { balanceMicros, capturedAt, now } = input;
  if (balanceMicros === null || capturedAt === null) return OK;
  if (now.getTime() - capturedAt.getTime() > PROVIDER_SNAPSHOT_STALE_MS) return OK;
  if (balanceMicros < callReserveMicros()) return { outcome: 'stop', reason: 'provider_exhausted' };
  if (balanceMicros < PROVIDER_LOW_BALANCE_MICROS)
    return { outcome: 'warn', reason: 'provider_low' };
  return OK;
}

const SEVERITY: Record<SpendDecision['outcome'], number> = { ok: 0, warn: 1, stop: 2 };

/** The more severe decision wins; on a tie `a` wins. */
export function mergeSpendDecisions(a: SpendDecision, b: SpendDecision): SpendDecision {
  return SEVERITY[b.outcome] > SEVERITY[a.outcome] ? b : a;
}

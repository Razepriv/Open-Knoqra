export const RECONCILE_MAX_AUTO_ADJUST_MICROS = 50_000_000;

export interface ReconcileInput {
  capturedMicros: number;
  /** Sum of earlier reconciliation adjust balance deltas (positive = refunds). */
  adjustedMicros: number;
  providerMicros: number | null;
}

export type ReconcileStatus = 'matched' | 'adjusted' | 'needs_review' | 'provider_unavailable';

export interface ReconcilePlan {
  ledgerMicros: number;
  driftMicros: number;
  status: ReconcileStatus;
  adjustBalanceDeltaMicros: number;
}

function assertSafe(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}

export function planReconciliation(input: ReconcileInput): ReconcilePlan {
  assertSafe(input.capturedMicros, 'capturedMicros');
  assertSafe(input.adjustedMicros, 'adjustedMicros');
  if (input.providerMicros !== null) assertSafe(input.providerMicros, 'providerMicros');

  const ledgerMicros = input.capturedMicros - input.adjustedMicros;
  if (input.providerMicros === null) {
    return {
      ledgerMicros,
      driftMicros: 0,
      status: 'provider_unavailable',
      adjustBalanceDeltaMicros: 0,
    };
  }
  const driftMicros = input.providerMicros - ledgerMicros;
  if (driftMicros === 0) {
    return { ledgerMicros, driftMicros, status: 'matched', adjustBalanceDeltaMicros: 0 };
  }
  if (Math.abs(driftMicros) > RECONCILE_MAX_AUTO_ADJUST_MICROS) {
    return { ledgerMicros, driftMicros, status: 'needs_review', adjustBalanceDeltaMicros: 0 };
  }
  return { ledgerMicros, driftMicros, status: 'adjusted', adjustBalanceDeltaMicros: -driftMicros };
}

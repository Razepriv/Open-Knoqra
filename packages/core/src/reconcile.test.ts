import { describe, expect, it } from 'vitest';
import { planReconciliation, RECONCILE_MAX_AUTO_ADJUST_MICROS } from './reconcile';

describe('planReconciliation', () => {
  it('adjusts small drift by refunding the difference', () => {
    expect(
      planReconciliation({ capturedMicros: 20_000, adjustedMicros: 0, providerMicros: 50_000 }),
    ).toEqual({
      ledgerMicros: 20_000,
      driftMicros: 30_000,
      status: 'adjusted',
      adjustBalanceDeltaMicros: -30_000,
    });
  });

  it('matches after a prior adjustment', () => {
    expect(
      planReconciliation({
        capturedMicros: 20_000,
        adjustedMicros: -30_000,
        providerMicros: 50_000,
      }),
    ).toEqual({
      ledgerMicros: 50_000,
      driftMicros: 0,
      status: 'matched',
      adjustBalanceDeltaMicros: 0,
    });
  });

  it('refunds when provider shows less than the ledger', () => {
    const plan = planReconciliation({
      capturedMicros: 20_000,
      adjustedMicros: 0,
      providerMicros: 0,
    });
    expect(plan.driftMicros).toBe(-20_000);
    expect(plan.status).toBe('adjusted');
    expect(plan.adjustBalanceDeltaMicros).toBe(20_000);
  });

  it('reports provider_unavailable on null', () => {
    expect(
      planReconciliation({ capturedMicros: 20_000, adjustedMicros: 0, providerMicros: null }),
    ).toEqual({
      ledgerMicros: 20_000,
      driftMicros: 0,
      status: 'provider_unavailable',
      adjustBalanceDeltaMicros: 0,
    });
  });

  it('flags drift above the limit for review', () => {
    const plan = planReconciliation({
      capturedMicros: 0,
      adjustedMicros: 0,
      providerMicros: 50_000_001,
    });
    expect(plan.status).toBe('needs_review');
    expect(plan.driftMicros).toBe(50_000_001);
    expect(plan.adjustBalanceDeltaMicros).toBe(0);
  });

  it('auto-adjusts drift exactly at the limit', () => {
    const plan = planReconciliation({
      capturedMicros: 0,
      adjustedMicros: 0,
      providerMicros: RECONCILE_MAX_AUTO_ADJUST_MICROS,
    });
    expect(plan.status).toBe('adjusted');
  });

  it('throws on non-safe-integer input', () => {
    expect(() =>
      planReconciliation({ capturedMicros: 1.5, adjustedMicros: 0, providerMicros: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      planReconciliation({ capturedMicros: 0, adjustedMicros: Number.NaN, providerMicros: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      planReconciliation({ capturedMicros: 0, adjustedMicros: 0, providerMicros: 0.5 }),
    ).toThrow(RangeError);
  });
});

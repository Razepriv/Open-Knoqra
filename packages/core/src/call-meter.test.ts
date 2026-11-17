import { describe, expect, it } from 'vitest';
import {
  CALL_CUTOFF_MARGIN_SECONDS,
  CALL_EXTEND_LEAD_SECONDS,
  cappedBillableSeconds,
  cutoffTime,
  extendCheckAt,
  paidUntil,
  planCallExtension,
} from './call-meter';

// $0.02 a minute: 10,000 price + 10,000 platform fee.
const base = {
  availableMicros: 1_000_000,
  periodSpendMicros: 0,
  heldMicros: 200_000,
  warnCapMicros: null,
  stopCapMicros: null,
  perMinuteMicros: 20_000,
};

describe('planCallExtension', () => {
  it('holds a full block of 10 minutes when the wallet covers it', () => {
    expect(planCallExtension(base)).toEqual({ kind: 'extend', minutes: 10, amountMicros: 200_000 });
  });

  it('holds only the whole minutes the wallet still covers', () => {
    expect(planCallExtension({ ...base, availableMicros: 69_999 })).toEqual({
      kind: 'extend',
      minutes: 3,
      amountMicros: 60_000,
    });
  });

  it('refuses for insufficient funds when not one minute fits', () => {
    expect(planCallExtension({ ...base, availableMicros: 19_999 })).toEqual({
      kind: 'refuse',
      reason: 'insufficient_funds',
    });
    expect(planCallExtension({ ...base, availableMicros: 0 })).toEqual({
      kind: 'refuse',
      reason: 'insufficient_funds',
    });
  });

  it('stays within the monthly stop cap (spent + held + request)', () => {
    // 100,000 spent + 200,000 held: 150,000 of cap left, so 7 minutes.
    expect(
      planCallExtension({ ...base, periodSpendMicros: 100_000, stopCapMicros: 450_000 }),
    ).toEqual({ kind: 'extend', minutes: 7, amountMicros: 140_000 });
  });

  it('refuses for the stop cap when the cap, not the wallet, is the limit', () => {
    expect(
      planCallExtension({ ...base, periodSpendMicros: 100_000, stopCapMicros: 310_000 }),
    ).toEqual({ kind: 'refuse', reason: 'stop_cap' });
  });

  it('never cuts a call for the warn cap', () => {
    expect(planCallExtension({ ...base, warnCapMicros: 1 })).toMatchObject({
      kind: 'extend',
      minutes: 10,
    });
  });

  it('rejects a per-minute price that is not a positive integer', () => {
    expect(() => planCallExtension({ ...base, perMinuteMicros: 0 })).toThrow(RangeError);
    expect(() => planCallExtension({ ...base, perMinuteMicros: 1.5 })).toThrow(RangeError);
  });
});

describe('call meter times', () => {
  const answered = new Date('2026-11-17T10:00:00.000Z');

  it('paid time runs from the answer', () => {
    expect(paidUntil(answered, 10).toISOString()).toBe('2026-11-17T10:10:00.000Z');
  });

  it('checks a lead before the paid time runs out', () => {
    expect(extendCheckAt(answered, 10).getTime()).toBe(
      paidUntil(answered, 10).getTime() - CALL_EXTEND_LEAD_SECONDS * 1000,
    );
  });

  it('cuts a margin before the paid time runs out, never in the past', () => {
    const at = paidUntil(answered, 10).getTime() - CALL_CUTOFF_MARGIN_SECONDS * 1000;
    expect(cutoffTime(answered, 10, answered).getTime()).toBe(at);
    const late = new Date(at + 5_000);
    expect(cutoffTime(answered, 10, late)).toEqual(late);
  });

  it('bills a call KNOQRA ends from the answer, capped at the paid minutes', () => {
    expect(cappedBillableSeconds(null, answered, 10)).toBeNull();
    expect(cappedBillableSeconds(answered, new Date('2026-11-17T10:09:50.200Z'), 10)).toBe(591);
    expect(cappedBillableSeconds(answered, new Date('2026-11-17T10:30:00.000Z'), 10)).toBe(600);
    expect(cappedBillableSeconds(answered, new Date('2026-11-17T09:59:00.000Z'), 10)).toBe(0);
  });
});

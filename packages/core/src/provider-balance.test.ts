import { describe, expect, it } from 'vitest';
import {
  evaluateProviderBalance,
  FAKE_PROVIDER_BALANCE_MICROS,
  mergeSpendDecisions,
  PROVIDER_LOW_BALANCE_MICROS,
  PROVIDER_SNAPSHOT_STALE_MS,
} from './provider-balance';
import type { SpendDecision } from './spend';

const now = new Date('2026-11-12T12:00:00Z');
const fresh = new Date(now.getTime() - 1000);
const stale = new Date(now.getTime() - PROVIDER_SNAPSHOT_STALE_MS - 1);
const OK: SpendDecision = { outcome: 'ok', reason: 'ok' };
const WARN: SpendDecision = { outcome: 'warn', reason: 'provider_low' };
const STOP: SpendDecision = { outcome: 'stop', reason: 'provider_exhausted' };

describe('constants', () => {
  it('match the plan', () => {
    expect(PROVIDER_LOW_BALANCE_MICROS).toBe(2_000_000);
    expect(PROVIDER_SNAPSHOT_STALE_MS).toBe(2 * 3600_000);
    expect(FAKE_PROVIDER_BALANCE_MICROS).toBe(50_000_000);
  });
});

describe('evaluateProviderBalance', () => {
  it.each([
    ['null balance', null, fresh, OK],
    ['null capturedAt', 0, null, OK],
    ['stale', 0, stale, OK],
    ['exactly at stale limit', 0, new Date(now.getTime() - PROVIDER_SNAPSHOT_STALE_MS), STOP],
    ['99,999', 99_999, fresh, STOP],
    ['negative', -5, fresh, STOP],
    ['100,000', 100_000, fresh, WARN],
    ['1,999,999', 1_999_999, fresh, WARN],
    ['2,000,000', 2_000_000, fresh, OK],
  ])('%s', (_name, balanceMicros, capturedAt, expected) => {
    expect(evaluateProviderBalance({ balanceMicros, capturedAt, now })).toEqual(expected);
  });
});

describe('mergeSpendDecisions', () => {
  const stopCap: SpendDecision = { outcome: 'stop', reason: 'stop_cap' };
  const warnCap: SpendDecision = { outcome: 'warn', reason: 'warn_cap' };
  it.each([
    [OK, OK, OK],
    [OK, WARN, WARN],
    [WARN, OK, WARN],
    [OK, STOP, STOP],
    [STOP, OK, STOP],
    [WARN, STOP, STOP],
    [STOP, WARN, STOP],
    [WARN, warnCap, WARN],
    [warnCap, WARN, warnCap],
    [STOP, stopCap, STOP],
    [stopCap, STOP, stopCap],
  ])('%j + %j', (a, b, expected) => {
    expect(mergeSpendDecisions(a, b)).toEqual(expected);
  });
});

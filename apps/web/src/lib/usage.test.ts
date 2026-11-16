import { describe, expect, it } from 'vitest';
import {
  defaultRange,
  filtersFromSearch,
  patchUsageSearch,
  providerStatusCopy,
  reconciliationStatusLabel,
  relativeAgo,
  spendBannerCopy,
  validateRange,
} from './usage';

describe('defaultRange', () => {
  it('runs from the first of the UTC month to today', () => {
    expect(defaultRange(new Date('2026-11-12T10:00:00Z'))).toEqual({
      from: '2026-11-01',
      to: '2026-11-12',
    });
  });
  it('uses the UTC date near midnight', () => {
    expect(defaultRange(new Date('2026-12-01T00:30:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-01',
    });
  });
});

describe('validateRange', () => {
  it.each([
    ['2026-11-01', '2026-11-12', null],
    ['2026-11-12', '2026-11-12', null],
    ['2026-11-13', '2026-11-12', 'Start date must be on or before the end date.'],
    ['2025-11-11', '2026-11-12', 'Choose a range of a year or less.'],
    ['2026-01-01', '2026-12-31', null],
    ['2024-01-01', '2024-12-31', null],
    ['2024-01-01', '2025-01-01', 'Choose a range of a year or less.'],
    ['', '2026-11-12', 'Choose a start and end date.'],
    ['2026-02-30', '2026-11-12', 'Choose a start and end date.'],
  ])('%s .. %s', (from, to, expected) => {
    expect(validateRange(from, to)).toBe(expected);
  });
});

describe('copy', () => {
  it('labels reconciliation statuses', () => {
    expect(reconciliationStatusLabel('needs_review')).toBe('Needs review');
    expect(reconciliationStatusLabel('provider_unavailable')).toBe('Provider unavailable');
    expect(reconciliationStatusLabel('matched')).toBe('Matched');
    expect(reconciliationStatusLabel('adjusted')).toBe('Adjusted');
  });
  it('shows nothing for an ok spend decision', () => {
    expect(spendBannerCopy({ outcome: 'ok', reason: 'ok' })).toBeNull();
  });
  it('reuses the dialer copy for provider reasons', () => {
    expect(spendBannerCopy({ outcome: 'warn', reason: 'provider_low' })).toBe(
      'Your Telnyx balance is low. Top it up in Telnyx to keep calling.',
    );
    expect(spendBannerCopy({ outcome: 'stop', reason: 'stop_cap' })).toBe(
      'Spend cap reached. Raise it in the wallet to call.',
    );
  });
  it('describes the provider snapshot status', () => {
    expect(providerStatusCopy('ok')).toBe('Connected');
    expect(providerStatusCopy('auth_failed')).toBe('Telnyx rejected the key');
    expect(providerStatusCopy('unavailable')).toBe('Telnyx unavailable');
  });
});

describe('relativeAgo', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  it.each([
    ['2026-11-12T11:59:45Z', 'just now'],
    ['2026-11-12T11:55:00Z', '5 min ago'],
    ['2026-11-12T09:00:00Z', '3 h ago'],
    ['2026-11-10T12:00:00Z', '2 d ago'],
  ])('%s', (iso, expected) => {
    expect(relativeAgo(iso, now)).toBe(expected);
  });
});

describe('patchUsageSearch', () => {
  const fallback = { from: '2026-11-01', to: '2026-11-13' };

  it('applies the patch to the latest search, not to an older render', () => {
    // Kind=all was chosen just before; the router already holds that search.
    expect(patchUsageSearch({}, { channel: 'sms' }, fallback)).toEqual({ channel: 'sms' });
  });
  it('drops a filter set back to all', () => {
    expect(
      patchUsageSearch({ kind: 'capture', channel: 'sms' }, { kind: 'all' }, fallback),
    ).toEqual({ channel: 'sms' });
    expect(patchUsageSearch({ channel: 'sms' }, { channel: 'all' }, fallback)).toEqual({});
  });
  it('keeps the dates only when they differ from the default range', () => {
    expect(patchUsageSearch({ from: '2026-10-01' }, { to: '2026-11-13' }, fallback)).toEqual({
      from: '2026-10-01',
    });
    expect(patchUsageSearch({}, { from: '2026-11-01' }, fallback)).toEqual({});
  });
});

describe('filtersFromSearch', () => {
  it('fills the defaults', () => {
    expect(
      filtersFromSearch({ kind: 'capture' }, { from: '2026-11-01', to: '2026-11-13' }),
    ).toEqual({ from: '2026-11-01', to: '2026-11-13', channel: 'all', kind: 'capture' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  capMarks,
  isOwnerOrAdmin,
  validateCaps,
  validateCredit,
  walletNotice,
  walletTone,
} from './wallet-form';

describe('validateCaps', () => {
  it('turns dollars into micros, and a blank field into off (null)', () => {
    expect(validateCaps('10', '16.50')).toEqual({
      ok: true,
      value: { warnCapMicros: 10_000_000, stopCapMicros: 16_500_000 },
    });
    expect(validateCaps('  ', '')).toEqual({
      ok: true,
      value: { warnCapMicros: null, stopCapMicros: null },
    });
  });

  it('says how to write an amount for junk', () => {
    expect(validateCaps('abc', '-1')).toEqual({
      ok: false,
      warnError: 'Enter an amount like 5 or 2.50',
      stopError: 'Enter an amount like 5 or 2.50',
    });
  });

  it('refuses a WARN above STOP, but allows them equal', () => {
    expect(validateCaps('6', '5')).toEqual({
      ok: false,
      warnError: 'WARN must be at or below STOP',
    });
    expect(validateCaps('5', '5').ok).toBe(true);
    expect(validateCaps('500', '').ok).toBe(true);
  });
});

describe('validateCredit', () => {
  it('accepts an amount and a note', () => {
    expect(validateCredit('2.50', ' Top up ')).toEqual({
      ok: true,
      value: { amountMicros: 2_500_000, note: 'Top up' },
    });
  });

  it('refuses zero, junk, more than $1,000 and an empty note', () => {
    expect(validateCredit('0', 'x')).toMatchObject({
      ok: false,
      amountError: 'Enter an amount like 5 or 2.50',
    });
    expect(validateCredit('5$', 'x')).toMatchObject({
      amountError: 'Enter an amount like 5 or 2.50',
    });
    expect(validateCredit('1000.01', 'x')).toMatchObject({
      amountError: 'Add up to $1,000 at a time.',
    });
    expect(validateCredit('5', '  ')).toEqual({
      ok: false,
      noteError: 'Say where this credit came from.',
    });
  });
});

describe('capMarks', () => {
  const base = { periodSpendMicros: 0, warnCapMicros: null, stopCapMicros: null };

  it('is null with no caps set', () => {
    expect(capMarks(base)).toBeNull();
  });

  it('places spend and both caps on a scale that ends at STOP', () => {
    expect(
      capMarks({
        periodSpendMicros: 4_000_000,
        warnCapMicros: 10_000_000,
        stopCapMicros: 16_000_000,
      }),
    ).toEqual({ usedPct: 25, warnPct: 62.5, stopPct: 100 });
  });

  it('caps the fill at 100% when spend passes the top cap', () => {
    expect(capMarks({ ...base, periodSpendMicros: 9, warnCapMicros: 3 })).toEqual({
      usedPct: 100,
      warnPct: 100,
      stopPct: null,
    });
  });
});

describe('walletTone and walletNotice', () => {
  it('maps the spend decision to a dot', () => {
    expect(walletTone({ outcome: 'ok', reason: 'ok' })).toBe('ok');
    expect(walletTone({ outcome: 'warn', reason: 'warn_cap' })).toBe('warn');
    expect(walletTone({ outcome: 'stop', reason: 'stop_cap' })).toBe('bad');
  });

  it('explains a stop', () => {
    expect(walletNotice({ outcome: 'stop', reason: 'stop_cap' })).toBe(
      "Calls are paused: the next call would pass this month's STOP cap.",
    );
    expect(walletNotice({ outcome: 'stop', reason: 'insufficient_funds' })).toBe(
      'Balance too low to hold a call.',
    );
    expect(walletNotice({ outcome: 'warn', reason: 'warn_cap' })).toBe(
      "You're near this month's spend cap.",
    );
    expect(walletNotice({ outcome: 'ok', reason: 'ok' })).toBeNull();
  });
});

describe('isOwnerOrAdmin', () => {
  it('is true for owners and admins only', () => {
    expect(isOwnerOrAdmin('owner')).toBe(true);
    expect(isOwnerOrAdmin('member, admin')).toBe(true);
    expect(isOwnerOrAdmin('member')).toBe(false);
    expect(isOwnerOrAdmin(undefined)).toBe(false);
  });
});

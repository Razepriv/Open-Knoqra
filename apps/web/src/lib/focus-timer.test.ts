import { describe, expect, it } from 'vitest';
import {
  FOCUS_SECONDS,
  FOCUS_STALE_MS,
  FOCUS_STORAGE_KEY,
  focusRemaining,
  formatClock,
  parseStoredEndsAt,
  restoreEndsAt,
} from './focus-timer';

describe('focus timer', () => {
  it('lasts 25 minutes and is stored under a namespaced key', () => {
    expect(FOCUS_SECONDS).toBe(1500);
    expect(FOCUS_STORAGE_KEY).toBe('knoqra.focus.endsAt');
  });

  it('counts whole seconds left before the end, rounding up', () => {
    const endsAt = 1_000_000;
    expect(focusRemaining(endsAt, endsAt - FOCUS_SECONDS * 1000)).toBe(1500);
    expect(focusRemaining(endsAt, endsAt - 1500)).toBe(2);
    expect(focusRemaining(endsAt, endsAt - 1)).toBe(1);
  });

  it('is zero at and after the end, and when nothing is running', () => {
    expect(focusRemaining(1_000_000, 1_000_000)).toBe(0);
    expect(focusRemaining(1_000_000, 1_000_001)).toBe(0);
    expect(focusRemaining(1_000_000, 9_000_000)).toBe(0);
    expect(focusRemaining(null, 1_000_000)).toBe(0);
  });

  it('formats seconds as a mm:ss clock', () => {
    expect(formatClock(1500)).toBe('25:00');
    expect(formatClock(1499)).toBe('24:59');
    expect(formatClock(61)).toBe('01:01');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(-5)).toBe('00:00');
  });

  it('reads a stored end time only when it is a finite number', () => {
    expect(parseStoredEndsAt('1700000000000')).toBe(1_700_000_000_000);
    expect(parseStoredEndsAt(null)).toBeNull();
    expect(parseStoredEndsAt('')).toBeNull();
    expect(parseStoredEndsAt('soon')).toBeNull();
    expect(parseStoredEndsAt('Infinity')).toBeNull();
    expect(parseStoredEndsAt('-4')).toBeNull();
  });

  it('resumes a running block, or one that just ran out, but drops a stale one', () => {
    const now = 5_000_000;
    expect(FOCUS_STALE_MS).toBe(60_000);
    expect(restoreEndsAt(String(now + 600_000), now)).toBe(now + 600_000);
    expect(restoreEndsAt(String(now - 30_000), now)).toBe(now - 30_000);
    expect(restoreEndsAt(String(now - 60_000), now)).toBe(now - 60_000);
    expect(restoreEndsAt(String(now - 60_001), now)).toBeNull();
    expect(restoreEndsAt(String(now - 86_400_000), now)).toBeNull();
    expect(restoreEndsAt(null, now)).toBeNull();
    expect(restoreEndsAt('later', now)).toBeNull();
  });
});

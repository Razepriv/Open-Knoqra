import { describe, expect, it, vi } from 'vitest';
import { HAPTIC_PATTERNS, type HapticPattern, haptic } from './haptics';

const NAMES: readonly HapticPattern[] = ['tap', 'success', 'warning', 'error'];

describe('haptic', () => {
  it('returns false and does nothing when vibrate is missing', () => {
    expect(haptic('tap', { vibrate: undefined, prefersReducedMotion: () => false })).toBe(false);
  });

  it('returns false without vibrating when reduced motion is set', () => {
    const vibrate = vi.fn(() => true);
    expect(haptic('success', { vibrate, prefersReducedMotion: () => true })).toBe(false);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('vibrates with the named pattern', () => {
    expect(HAPTIC_PATTERNS).toEqual({
      tap: 10,
      success: [12, 40, 18],
      warning: [30, 60, 30],
      error: [40, 50, 40, 50, 40],
    });
    for (const name of NAMES) {
      const vibrate = vi.fn(() => true);
      expect(haptic(name, { vibrate, prefersReducedMotion: () => false })).toBe(true);
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(vibrate).toHaveBeenCalledWith(HAPTIC_PATTERNS[name]);
    }
  });

  it('returns false when vibrate throws', () => {
    const vibrate = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(haptic('tap', { vibrate, prefersReducedMotion: () => false })).toBe(false);
  });

  it('returns false when vibrate returns false', () => {
    const vibrate = vi.fn(() => false);
    expect(haptic('tap', { vibrate, prefersReducedMotion: () => false })).toBe(false);
  });

  it('works with no env in Node', () => {
    expect(haptic('tap')).toBe(false);
  });
});

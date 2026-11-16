export type HapticPattern = 'tap' | 'success' | 'warning' | 'error';

/** Vibration patterns in milliseconds. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticPattern, number | readonly number[]>> = {
  tap: 10,
  success: [12, 40, 18],
  warning: [30, 60, 30],
  error: [40, 50, 40, 50, 40],
};

export interface HapticEnv {
  vibrate?: ((pattern: number | number[]) => boolean) | undefined;
  prefersReducedMotion?: () => boolean;
}

function defaultVibrate(): HapticEnv['vibrate'] {
  const nav = globalThis.navigator as Navigator | undefined;
  if (typeof nav?.vibrate !== 'function') return undefined;
  return nav.vibrate.bind(nav);
}

function defaultPrefersReducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Vibrates where supported and motion is allowed. Never throws. Returns true when it vibrated. */
export function haptic(pattern: HapticPattern, env: HapticEnv = {}): boolean {
  try {
    const vibrate = 'vibrate' in env ? env.vibrate : defaultVibrate();
    if (!vibrate) return false;
    const reduced = (env.prefersReducedMotion ?? defaultPrefersReducedMotion)();
    if (reduced) return false;
    const value = HAPTIC_PATTERNS[pattern];
    return vibrate(typeof value === 'number' ? value : [...value]) === true;
  } catch {
    return false;
  }
}

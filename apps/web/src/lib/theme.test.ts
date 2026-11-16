import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  nextThemePreference,
  parseThemePreference,
  THEME_STORAGE_KEY,
  themeCycleLabel,
} from './theme';

describe('nextThemePreference', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextThemePreference('system')).toBe('light');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
  });
});

describe('parseThemePreference', () => {
  it('accepts the three preferences and rejects anything else', () => {
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('blue')).toBeNull();
    expect(parseThemePreference(undefined)).toBeNull();
  });
});

describe('themeCycleLabel', () => {
  it('names the current preference and what a press does', () => {
    expect(themeCycleLabel('system')).toBe('Theme: system. Switch to light');
    expect(themeCycleLabel('dark')).toBe('Theme: dark. Switch to system');
  });
});

describe('applyTheme', () => {
  let dataset: Record<string, string | undefined>;
  let store: Map<string, string>;

  beforeEach(() => {
    dataset = {};
    store = new Map();
    vi.stubGlobal('document', { documentElement: { dataset } });
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets data-theme and the pre-paint cache for an explicit theme', () => {
    applyTheme('dark');
    expect(dataset.theme).toBe('dark');
    expect(store.get(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('clears both for system so prefers-color-scheme decides', () => {
    applyTheme('light');
    applyTheme('system');
    expect(dataset.theme).toBeUndefined();
    expect(store.has(THEME_STORAGE_KEY)).toBe(false);
  });
});

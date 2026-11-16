import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** What the user chose: an explicit theme, or `system` to follow the OS. Stored server-side. */
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'knoqra.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function oppositeTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark';
}

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};

/** The toggle's order: system → light → dark → system. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  return CYCLE[current];
}

/** Accessible name of the cycle button: the current choice and what a press does. */
export function themeCycleLabel(current: ThemePreference): string {
  return `Theme: ${current}. Switch to ${nextThemePreference(current)}`;
}

function clearStoredTheme(): void {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing cached, nothing to clear.
  }
}

/**
 * Puts a preference on screen. `light`/`dark` set `data-theme` and the pre-paint cache read by
 * index.html; `system` removes both so the prefers-color-scheme block in tokens.css decides.
 * The server preference stays the source of truth; localStorage only avoids a flash on load.
 */
export function applyTheme(preference: ThemePreference): void {
  if (preference === 'system') {
    delete document.documentElement.dataset.theme;
    clearStoredTheme();
    return;
  }
  document.documentElement.dataset.theme = preference;
  storeTheme(preference);
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked (private mode, policy): the theme still applies for this visit.
  }
}

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** The theme on screen: an explicit `data-theme`, else the system preference. */
export function effectiveTheme(): Theme {
  return parseTheme(document.documentElement.dataset.theme) ?? systemTheme();
}

/**
 * Light/dark state for the toggle on signed-out pages only (auth). Signed-in screens use
 * `useThemePreference`, whose three-state choice is saved to the account.
 *
 * The saved theme (localStorage `knoqra.theme`) is applied before
 * first paint by the inline script in index.html; with nothing saved, `data-theme` stays unset and
 * the prefers-color-scheme block in tokens.css follows the system.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(effectiveTheme);

  useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setTheme(effectiveTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    const next = oppositeTheme(effectiveTheme());
    document.documentElement.dataset.theme = next;
    storeTheme(next);
    setTheme(next);
  }, []);

  return { theme, toggle };
}

import { useEffect, useRef } from 'react';
import { browserPlatform, isApplePlatform } from './platform';

/** Cmd+K on Apple platforms, Ctrl+K elsewhere. Shift and Alt turn it into another shortcut. */
export function isPaletteShortcut(e: KeyboardEvent, platform: string = browserPlatform()): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return false;
  return isApplePlatform(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Runs `handler` when `match` accepts a keydown anywhere in the window, even from an input. A
 * match calls preventDefault, because Ctrl+K is the browser's own search shortcut.
 */
export function useGlobalShortcut(match: (e: KeyboardEvent) => boolean, handler: () => void) {
  const latest = useRef({ match, handler });
  latest.current = { match, handler };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.defaultPrevented) return;
      if (!latest.current.match(e)) return;
      e.preventDefault();
      latest.current.handler();
    };
    // Capture phase: cmdk also claims Ctrl+K (vim-style up) and would otherwise mark it handled first.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

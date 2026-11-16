import { useSyncExternalStore } from 'react';

/** Tracks a CSS media query. Used where the same content must render in one place, not two. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Three panes at 1280px and up; below that the context ribbon becomes a drawer. */
export const WIDE_QUERY = '(min-width: 1280px)';

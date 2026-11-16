import { useEffect, useRef } from 'react';

export interface LoadMoreOptions {
  /** False when there is no next page, or the last attempt failed (the button retries instead). */
  enabled: boolean;
  busy: boolean;
  loadMore: () => void;
  /** Changes whenever a page arrives, so the observer is re-armed if the end is still in view. */
  pageCount: number;
}

/**
 * Loads the next page when the returned sentinel scrolls into view. Without IntersectionObserver
 * nothing happens, and the visible "Load more" button is the way to continue.
 */
export function useLoadMoreOnScroll({ enabled, busy, loadMore, pageCount }: LoadMoreOptions) {
  const sentinel = useRef<HTMLLIElement | null>(null);
  // Held in a ref so a new function identity on every render does not rebuild the observer: a
  // fresh observer fires at once for an in-view target, which would loop on a failing request.
  const load = useRef(loadMore);
  load.current = loadMore;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pageCount` re-arms the observer after each page
  useEffect(() => {
    const target = sentinel.current;
    if (!enabled || busy || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current();
      },
      { rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, busy, pageCount]);
  return sentinel;
}

import { ApiError, NetworkError } from './api';

export type StateKind = 'offline' | 'denied' | 'not-found' | 'error';

/**
 * What a failed query should look like. A 403 (or the `forbidden` code) is a permission problem, a
 * 404 is a missing record, a failure to get any answer (or a browser that reports it is offline)
 * is an offline state, and everything else, including a 5xx, is a plain error.
 */
export function queryStateKind(error: unknown, online: boolean): StateKind {
  if (error instanceof ApiError) {
    if (error.status === 403 || error.code === 'forbidden') return 'denied';
    if (!online) return 'offline';
    if (error.status === 404) return 'not-found';
    return 'error';
  }
  if (!online) return 'offline';
  if (error instanceof NetworkError || error instanceof TypeError) return 'offline';
  return 'error';
}

/**
 * TanStack Query's own default pauses a mutation while the browser reports offline, which leaves a
 * form stuck behind a disabled button. The app's QueryClient (main.tsx) already defaults every
 * query and mutation to 'always', so a save runs, fails with a NetworkError and shows the failure
 * at once. Hooks that must fail fast also set it explicitly, so they keep doing so under any
 * QueryClient (tests, a future default change).
 */
export const OFFLINE_FAILS_FAST = 'always' as const;

/**
 * A load failed and there is nothing to show. A screen that already has data keeps showing it when
 * a background refetch fails (queries run with networkMode 'always', so offline refetches do fail);
 * the OfflineBanner says the browser is offline. Only a first load that failed shows an error state.
 */
export function loadFailed(query: { isError: boolean; data: unknown }): boolean {
  return query.isError && query.data === undefined;
}

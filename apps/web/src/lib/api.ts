import { type components, createApiClient } from '@knoqra/api-client';
import { useQuery } from '@tanstack/react-query';

/** The request never got an answer: offline, DNS, connection refused, a dropped connection. */
export class NetworkError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Could not reach the server.', options);
    this.name = 'NetworkError';
  }
}

/**
 * Wraps fetch so only a genuine failure to get a response becomes a NetworkError. Other code that
 * throws a TypeError (a bug in a queryFn, say) stays a plain error and is not shown as an outage.
 * An aborted request is passed through: it is a cancellation, not a failure.
 */
export function networkAwareFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (...args) => {
    try {
      return await fetchImpl(...args);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError({ cause: error });
    }
  };
}

/** Same-origin API client: requests go to /api/v1/* on the page's own origin. */
export const api = createApiClient({
  baseUrl: '',
  fetch: networkAwareFetch((...args) => globalThis.fetch(...args)),
});

export type Me = components['schemas']['Me'];

export const meQueryKey = ['me'] as const;

/** A non-2xx API answer, carrying the HTTP status so callers can tell signed-out from broken. */
export class ApiError extends Error {
  readonly status: number;
  /** The API's machine-readable error code, such as `duplicate_contact`. */
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** True for a network failure or a 5xx: the server could not be reached, which is not a sign-out. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 500;
  return error instanceof NetworkError;
}

interface ApiResult<T> {
  data?: { data?: T | null } | undefined;
  error?: { error?: { message?: string; code?: string } | null } | undefined;
  response: { status: number };
}

/** Unwraps the `{ data }` envelope, or throws an ApiError with the HTTP status. */
export function throwIfFailed<T>(result: ApiResult<T>, fallbackMessage: string): T {
  const value = result.data?.data;
  if (value !== undefined && value !== null) return value;
  throw new ApiError(
    result.response.status,
    result.error?.error?.message ?? fallbackMessage,
    result.error?.error?.code,
  );
}

export async function fetchMe(): Promise<Me> {
  return throwIfFailed(await api.GET('/api/v1/me'), 'Could not load your account.');
}

/** The signed-in user and their active workspace. */
export function useMe({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: meQueryKey, queryFn: fetchMe, enabled });
}

const SIGN_IN_PATH = '/sign-in';
const BACKSLASH = String.fromCharCode(92);

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A same-origin path to return to after signing in, or undefined. Rejects anything that could
 * send the user off-site (`//host`, `/\host`, absolute URLs) and the sign-in page itself.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  // Browsers strip tabs and newlines inside URLs, so `/<tab>/host` would become `//host`.
  if (hasControlCharacter(value)) return undefined;
  // Browsers treat a backslash like a slash, so `/\host` is as off-site as `//host`.
  if (value.startsWith('//') || value.startsWith(`/${BACKSLASH}`)) return undefined;
  if (value === SIGN_IN_PATH || value.startsWith(`${SIGN_IN_PATH}?`)) return undefined;
  return value;
}

/** Search params for the sign-in page that bring the user back to `pathname` afterwards. */
export function signInSearch(pathname: string, searchStr = ''): { next?: string } {
  const next = pathname === '/' ? undefined : safeNext(`${pathname}${searchStr}`);
  return next ? { next } : {};
}

/** The slice of the TanStack router the 401 handler needs. */
export interface UnauthorizedRouter {
  navigate: (options: { to: '/sign-in'; search: { next?: string; expired?: true } }) => unknown;
  state: { location: { pathname: string; searchStr: string } };
}

/**
 * Builds the global 401 handler for the QueryClient caches. A 401 means the session ended, so it
 * clears cached data and goes to `/sign-in?next=<page>`. Network failures and 5xx are left alone:
 * those keep the user on the page, where the outage state offers a retry.
 */
export function createUnauthorizedHandler(
  router: UnauthorizedRouter,
  queryClient: { clear: () => void },
): (error: unknown) => void {
  let redirecting = false;
  return (error) => {
    if (!isUnauthorized(error) || redirecting) return;
    const { pathname, searchStr } = router.state.location;
    if (pathname === SIGN_IN_PATH) return;
    redirecting = true;
    queryClient.clear();
    const done = () => {
      redirecting = false;
    };
    Promise.resolve(
      router.navigate({
        to: SIGN_IN_PATH,
        search: { ...signInSearch(pathname, searchStr), expired: true },
      }),
    ).then(done, done);
  };
}

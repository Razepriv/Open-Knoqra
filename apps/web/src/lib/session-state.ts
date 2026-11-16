/** What a session check found. `unreachable` means we could not tell, which is not signed out. */
export type SessionState<S> =
  | { status: 'authenticated'; session: S }
  | { status: 'unauthenticated' }
  | { status: 'unreachable' };

interface SessionResult<S> {
  data: S | null;
  error: { status?: number | undefined } | null;
}

/** Statuses where the server answered and the answer is "you are not signed in". */
const SIGNED_OUT_STATUSES = new Set([401]);

/**
 * Turns a Better Auth `getSession` result (or a thrown network error) into a SessionState.
 * A session means authenticated. A 401, or a clean "no session" answer, means signed out.
 * Everything else (no HTTP status, 5xx, a thrown fetch) means the server could not be asked, and
 * redirecting to sign-in then would wrongly look like a sign-out.
 */
export function classifySession<S>(result: unknown): SessionState<S> {
  if (!isSessionResult<S>(result)) return { status: 'unreachable' };
  if (result.data) return { status: 'authenticated', session: result.data };
  if (!result.error) return { status: 'unauthenticated' };
  const status = result.error.status;
  if (status !== undefined && SIGNED_OUT_STATUSES.has(status)) return { status: 'unauthenticated' };
  return { status: 'unreachable' };
}

function isSessionResult<S>(value: unknown): value is SessionResult<S> {
  return typeof value === 'object' && value !== null && 'data' in value && 'error' in value;
}

/**
 * Path redaction for logs and Sentry. Some URLs carry live credentials in the path: Better Auth's
 * reset link is `/api/auth/reset-password/<token>`, so a raw pathname would put a valid token in
 * `request.completed`, `request.failed` and Sentry transaction names.
 *
 * Rules (the query string and fragment are always dropped):
 * 1. Under `/api/auth/`, only the first segment is kept (`/api/auth/reset-password`); every later
 *    segment becomes `[redacted]`.
 * 2. Anywhere else, a segment of 20 or more token characters (`A-Z a-z 0-9 _ - . ~ % + =`) becomes
 *    `[redacted]`, unless it is
 *    - a KNOQRA id: a known prefix, `_` and 32 lowercase hex (`ct_…`, `pe_…`, see `@knoqra/core`
 *      `newId`), which carries no secret and keeps logs useful, or
 *    - a lowercase kebab-case word (`list-user-invitations`), which is a route name, not a token.
 *    Unprefixed long values (UUIDs, random tokens, JWTs, percent-encoded strings) are redacted.
 */

export const REDACTED_SEGMENT = '[redacted]';

const AUTH_PREFIX = '/api/auth/';
const LONG_TOKEN = /^[A-Za-z0-9_.~%+=-]{20,}$/;
const KNOQRA_ID = /^(?:ct|ae|pe|cp|te|dd)_[0-9a-f]{32}$/;
const ROUTE_WORD = /^[a-z]+(?:-[a-z]+)*$/;

function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

function redactSegment(segment: string): string {
  if (!LONG_TOKEN.test(segment)) return segment;
  if (KNOQRA_ID.test(segment) || ROUTE_WORD.test(segment)) return segment;
  return REDACTED_SEGMENT;
}

/** Returns `pathname` with credentials replaced by `[redacted]` and no query string. */
export function redactPath(pathname: string): string {
  const path = stripQuery(pathname);
  if (path.startsWith(AUTH_PREFIX)) {
    const [first = '', ...rest] = path.slice(AUTH_PREFIX.length).split('/');
    const tail = rest.map((segment) => (segment === '' ? '' : REDACTED_SEGMENT));
    return [`${AUTH_PREFIX}${redactSegment(first)}`, ...tail].join('/');
  }
  return path.split('/').map(redactSegment).join('/');
}

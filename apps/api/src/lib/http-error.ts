import type { Context } from 'hono';
import type { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type ErrorCode, fail } from './envelope';

/** Message Hono's JSON validator uses when the body cannot be parsed. */
const MALFORMED_JSON = 'Malformed JSON in request body';

function codeFor(status: number): ErrorCode {
  if (status === 400) return 'validation_error';
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'not_found';
  return 'internal_error';
}

/**
 * Maps an HTTPException into the `/api/v1/*` error envelope by status, keeping the status.
 * A 400 keeps the exception's own message, except the validator's malformed-JSON case, which gets
 * a friendlier one. Other statuses never leak the exception text.
 */
export function httpExceptionResponse(error: HTTPException, c: Context): Response {
  const status = error.status;
  const code = codeFor(status);
  const message =
    status === 400
      ? error.message === MALFORMED_JSON || !error.message
        ? 'The request body is not valid JSON.'
        : error.message
      : status === 401
        ? 'Sign in required.'
        : status === 404
          ? 'Not found.'
          : 'Something went wrong.';
  return fail(c, status as ContentfulStatusCode, code, message);
}

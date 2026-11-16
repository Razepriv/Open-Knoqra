import { createMiddleware } from 'hono/factory';
import { createAuth } from '../auth/auth';
import type { AppEnv } from './context';
import { logger } from './logger';

/**
 * Hands a background auth task (reset mail) to the host. A failure is logged through the redacting
 * logger, never thrown and never dropped silently, so no link or body can leak.
 */
export function runBackgroundTask(
  promise: Promise<unknown>,
  hostWaitUntil?: (promise: Promise<unknown>) => void,
): void {
  const guarded = promise.catch((error: unknown) => {
    logger.error('auth.background_task_failed', { error });
  });
  if (!hostWaitUntil) return;
  try {
    hostWaitUntil(guarded);
  } catch {
    // The host has no execution context: the guarded promise still runs, just unawaited.
  }
}

/** Builds the request's Better Auth instance on the request's db handle (requires `requestDb`). */
export const requestAuth = createMiddleware<AppEnv>(async (c, next) => {
  c.set(
    'auth',
    createAuth(c.env, c.var.db, {
      waitUntil: (promise) =>
        runBackgroundTask(promise, (p) => {
          c.executionCtx.waitUntil(p);
        }),
    }),
  );
  await next();
});

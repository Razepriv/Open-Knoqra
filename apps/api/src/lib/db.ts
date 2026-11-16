import { createDb } from '@knoqra/db';
import { createMiddleware } from 'hono/factory';
import { connectionString } from '../env';
import type { AppEnv } from './context';
import { logger } from './logger';

/**
 * Opens one Postgres handle for the request (a pg Pool of one connection, so a `withTenant`
 * callback must use its `tx`, never `db`) and closes it after the response is sent.
 * Per request because Workers I/O objects cannot be shared across requests.
 */
export const requestDb = createMiddleware<AppEnv>(async (c, next) => {
  const { db, close } = createDb(connectionString(c.env));
  c.set('db', db);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(
      close().catch((error: unknown) => logger.warn('db.close_failed', { error })),
    );
  }
});

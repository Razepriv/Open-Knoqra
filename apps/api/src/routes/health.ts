import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { createDb } from '@knoqra/db';
import { sql } from 'drizzle-orm';
import { connectionString } from '../env';
import type { AppEnv } from '../lib/context';
import { logger } from '../lib/logger';

/** The health check answers within this budget even when Postgres never responds. */
export const HEALTH_DB_TIMEOUT_MS = 2000;

const Healthy = z.object({ status: z.literal('ok'), db: z.literal('ok') }).openapi('Healthy');
const Degraded = z
  .object({ status: z.literal('degraded'), db: z.literal('unreachable') })
  .openapi('Degraded');

const route = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['system'],
  summary: 'Liveness and database reachability',
  responses: {
    200: {
      description: 'API and database are up',
      content: { 'application/json': { schema: Healthy } },
    },
    503: {
      description: 'The database did not answer within 2 s',
      content: { 'application/json': { schema: Degraded } },
    },
  },
});

/** `select 1` raced against the timeout. Never throws. */
async function pingDatabase(
  url: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<boolean> {
  const { db, close } = createDb(url, { connectionTimeoutMillis: HEALTH_DB_TIMEOUT_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), HEALTH_DB_TIMEOUT_MS);
  });
  const ping = db.execute(sql`select 1`).then(
    () => true,
    (error: unknown) => {
      logger.warn('health.db_unreachable', { error });
      return false;
    },
  );
  try {
    return await Promise.race([ping, timedOut]);
  } finally {
    clearTimeout(timer);
    waitUntil(close().catch(() => undefined));
  }
}

export const health = new OpenAPIHono<AppEnv>().openapi(route, async (c) => {
  let reachable = false;
  try {
    reachable = await pingDatabase(connectionString(c.env), (p) => c.executionCtx.waitUntil(p));
  } catch (error) {
    logger.error('health.check_failed', { error });
  }
  return reachable
    ? c.json({ status: 'ok' as const, db: 'ok' as const }, 200)
    : c.json({ status: 'degraded' as const, db: 'unreachable' as const }, 503);
});

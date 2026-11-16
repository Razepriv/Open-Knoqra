import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../lib/context';
import { fail } from '../lib/envelope';
import { REALTIME_USER_HEADER } from '../lib/realtime';

export const REALTIME_PATH = '/api/v1/realtime';

/**
 * Cheap checks for the realtime upgrade, registered before the `/api/v1/*` session chain so a
 * request that is not a WebSocket upgrade, or that comes from a foreign page, never costs a
 * database session lookup. The Origin check is the CSRF defence for WebSockets: browsers attach the
 * session cookie to cross-site upgrades and do not apply CORS to them.
 */
export const realtimeGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    c.header('upgrade', 'websocket');
    return fail(c, 426, 'validation_error', 'Expected a WebSocket upgrade.');
  }
  if (c.req.header('origin') !== new URL(c.env.BETTER_AUTH_URL).origin) {
    return fail(c, 403, 'forbidden', 'This origin may not open a realtime connection.');
  }
  await next();
});

/**
 * `GET /api/v1/realtime`: hands the authenticated socket to the organization's OrgRealtime
 * object, tagged with the user id. Not part of the OpenAPI document (it is not a JSON endpoint).
 */
export const realtime = new Hono<AppEnv>().get(REALTIME_PATH, (c) => {
  const { orgId, userId } = c.var.tenant;
  const stub = c.env.ORG_REALTIME.get(c.env.ORG_REALTIME.idFromName(orgId));
  return stub.fetch(
    new Request('https://do/connect', {
      headers: { upgrade: 'websocket', [REALTIME_USER_HEADER]: userId },
    }),
  );
});

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { HEALTH_CHECKS } from '../health/registry';
import { overallStatus, runHealthChecks } from '../health/run';
import { CHECK_STATUSES, OVERALL_STATUSES, SYSTEM_STATUS_ROLES } from '../health/types';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';

const CheckResult = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.enum(CHECK_STATUSES),
    detail: z.string(),
    durationMs: z.number().int(),
    data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).nullable(),
  })
  .openapi('CheckResult');

const SystemHealth = z
  .object({
    status: z.enum(OVERALL_STATUSES),
    checkedAt: z.iso.datetime(),
    release: z.string().nullable(),
    environment: z.enum(['development', 'test', 'staging', 'production']),
    checks: z.array(CheckResult),
  })
  .openapi('SystemHealth');

const route = createRoute({
  method: 'get',
  path: '/api/health/deep',
  tags: ['system'],
  summary: 'Detailed health of this server, for workspace owners and admins',
  description:
    'Always 200 with the report when authorized; read `data.status`. Uptime monitors use /api/health.',
  security: [{ session: [] }],
  responses: {
    200: {
      description: 'Health report',
      content: { 'application/json': { schema: okEnvelope(SystemHealth) } },
    },
    401: errorResponse('No valid session'),
    403: errorResponse('The member is not an owner or admin of the active organization'),
    409: errorResponse('No active organization the user belongs to'),
    500: errorResponse('The session could not be verified (for example, the database is down)'),
  },
});

/** Mounted behind requestDb, requestAuth and tenant() in app.ts. */
export const healthDeep = new OpenAPIHono<AppEnv>().openapi(route, async (c) => {
  if (!SYSTEM_STATUS_ROLES.includes(c.var.tenant.role)) {
    return fail(c, 403, 'forbidden', 'Only workspace owners and admins can see system status.');
  }
  const now = new Date();
  const checks = await runHealthChecks(HEALTH_CHECKS, { env: c.env, db: c.var.db, now });
  c.header('cache-control', 'no-store');
  return ok(
    c,
    {
      status: overallStatus(checks, HEALTH_CHECKS),
      checkedAt: now.toISOString(),
      release: c.env.SENTRY_RELEASE?.trim() || null,
      environment: c.env.APP_ENV,
      checks,
    },
    200,
  );
});

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { providerUsageRecord, withTenant } from '@knoqra/db';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { DateStringSchema } from '../lib/m4-schemas';
import { pollOrgBalance } from '../services/balance-poll';

/**
 * Development driver for the fake provider's balance and usage. 404 in production and whenever
 * FAKE_WEBHOOK_SECRET is unset, before any validation (same guard as dev-fake-voice).
 */

const MAX_BALANCE_MICROS = Number.MAX_SAFE_INTEGER;
const MAX_USAGE_COST_MICROS = 10_000_000;

const BalanceBody = z
  .object({ balanceMicros: z.number().int().min(0).max(MAX_BALANCE_MICROS) })
  .openapi('FakeProviderBalance');

const UsageBody = z
  .object({
    date: DateStringSchema,
    costMicros: z.number().int().min(1).max(MAX_USAGE_COST_MICROS),
    quantity: z.number().int().min(0).optional(),
  })
  .openapi('FakeProviderUsage');

const AcceptedSchema = z.object({ accepted: z.literal(true) }).openapi('FakeProviderAccepted');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
const unavailable = 'Not production, and FAKE_WEBHOOK_SECRET is configured';

const balanceRoute = createRoute({
  method: 'post',
  path: '/api/v1/dev/fake-provider/balance',
  tags: ['dev'],
  summary: 'Development only: set the fake provider balance and poll it now',
  security,
  request: { body: { required: true, content: json(BalanceBody) } },
  responses: {
    202: { description: 'Balance polled', content: json(okEnvelope(AcceptedSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse(`Unavailable (${unavailable})`),
    409: errorResponse('No active organization'),
  },
});

const usageRoute = createRoute({
  method: 'post',
  path: '/api/v1/dev/fake-provider/usage',
  tags: ['dev'],
  summary: 'Development only: seed one fake provider usage record to create drift',
  security,
  request: { body: { required: true, content: json(UsageBody) } },
  responses: {
    202: { description: 'Usage record inserted', content: json(okEnvelope(AcceptedSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse(`Unavailable (${unavailable})`),
    409: errorResponse('No active organization'),
  },
});

const driverAvailable = (env: Env): boolean =>
  env.APP_ENV !== 'production' && Boolean(env.FAKE_WEBHOOK_SECRET);

/** Runs before route validation, so production never reveals the request schema. */
const devGate = createMiddleware<AppEnv>(async (c, next) => {
  if (!driverAvailable(c.env)) return fail(c, 404, 'not_found', 'No such route.');
  await next();
});

export const devFakeProvider = new OpenAPIHono<AppEnv>();
devFakeProvider.use('/api/v1/dev/fake-provider/*', devGate);
devFakeProvider
  .openapi(balanceRoute, async (c) => {
    const { db, tenant } = c.var;
    const { balanceMicros } = c.req.valid('json');
    await pollOrgBalance(db, c.env, tenant.orgId, { fakeBalanceMicros: balanceMicros });
    return ok(c, { accepted: true as const }, 202);
  })
  .openapi(usageRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    await withTenant(db, tenant.orgId, (tx) =>
      tx.insert(providerUsageRecord).values({
        organizationId: tenant.orgId,
        provider: 'fake',
        service: 'voice',
        quantity: body.quantity ?? null,
        unit: body.quantity === undefined ? null : 'second',
        costMicros: body.costMicros,
        occurredAt: new Date(`${body.date}T12:00:00.000Z`),
        providerRef: `fake_drift_${crypto.randomUUID()}`,
      }),
    );
    return ok(c, { accepted: true as const }, 202);
  });

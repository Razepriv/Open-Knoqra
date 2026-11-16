import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi';
import { evaluateSetupChecks, SETUP_STEPS, type SetupStep } from '@knoqra/core';
import { call, setupProgress, type Tx, withTenant } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import {
  type SetupJson,
  SetupSchema,
  type UpdateSetupBody,
  UpdateSetupSchema,
} from '../lib/m4-schemas';
import { insertUsageAudit } from '../lib/usage-audit';
import { gatherSetupFacts } from '../services/setup-facts';

const CALL_ID_PATTERN = /^cl_[0-9a-f]{32}$/;

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/setup',
  tags: ['setup'],
  summary: "The caller's resumable setup progress and the workspace setup checks",
  security,
  responses: {
    200: { description: 'Setup progress and checks', content: json(okEnvelope(SetupSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/setup',
  tags: ['setup'],
  summary: "Update the caller's setup progress",
  security,
  request: { body: { required: true, content: json(UpdateSetupSchema) } },
  responses: {
    200: { description: 'Updated setup progress', content: json(okEnvelope(SetupSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    404: errorResponse("The test call is missing, in another organization or not the caller's"),
    409: errorResponse('The test call is not completed (invalid_state), or no active organization'),
  },
});

type Env = AppEnv['Bindings'];

async function buildSetup(tx: Tx, env: Env, tenant: Tenant): Promise<SetupJson> {
  const facts = await gatherSetupFacts(tx, env);
  const [row] = await tx
    .select()
    .from(setupProgress)
    .where(eq(setupProgress.userId, tenant.userId))
    .limit(1);
  const done: Record<SetupStep, boolean> = {
    connect: facts.credentialStored,
    number: facts.assignedForCalls,
    audio: Boolean(row?.audioCheckedAt),
    test_call: Boolean(row?.testCallId),
  };
  return {
    steps: SETUP_STEPS.map((id) => ({ id, done: done[id] })),
    currentStep: SETUP_STEPS.find((id) => !done[id]) ?? null,
    lastStep: row?.lastStep ?? null,
    dismissedAt: row?.dismissedAt?.toISOString() ?? null,
    completedAt: row?.completedAt?.toISOString() ?? null,
    checks: evaluateSetupChecks(facts),
  };
}

type TestCallVerdict = 'ok' | 'not_found' | 'invalid_state';

async function checkTestCall(tx: Tx, tenant: Tenant, id: string): Promise<TestCallVerdict> {
  if (!CALL_ID_PATTERN.test(id)) return 'not_found';
  const [row] = await tx
    .select({ state: call.state })
    .from(call)
    .where(and(eq(call.id, id), eq(call.userId, tenant.userId)))
    .limit(1);
  if (!row) return 'not_found';
  return row.state === 'completed' ? 'ok' : 'invalid_state';
}

function progressChanges(body: UpdateSetupBody, now: Date) {
  return {
    ...(body.lastStep ? { lastStep: body.lastStep } : {}),
    ...(body.audioChecked ? { audioCheckedAt: now } : {}),
    ...(body.testCallId ? { testCallId: body.testCallId } : {}),
    ...(body.dismissed === undefined ? {} : { dismissedAt: body.dismissed ? now : null }),
  };
}

const changedFields = (body: UpdateSetupBody) =>
  (Object.keys(body) as (keyof UpdateSetupBody)[]).filter((k) => body[k] !== undefined);

export const setupRoutes = new OpenAPIHono<AppEnv>();
setupRoutes
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const setup = await withTenant(db, tenant.orgId, (tx) => buildSetup(tx, c.env, tenant));
    return ok(c, setup, 200);
  })
  .openapi(patchRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    const outcome = await withTenant(db, tenant.orgId, async (tx) => {
      if (body.testCallId) {
        const verdict = await checkTestCall(tx, tenant, body.testCallId);
        if (verdict !== 'ok') {
          await insertUsageAudit(tx, tenant, {
            action: 'setup.update',
            outcome: verdict === 'not_found' ? 'not_found' : 'denied',
            entityType: 'setup',
            metadata: {
              reason: verdict === 'not_found' ? 'test_call_not_found' : 'test_call_state',
            },
          });
          return { verdict } as const;
        }
      }
      const now = new Date();
      const changes = progressChanges(body, now);
      await tx
        .insert(setupProgress)
        .values({ organizationId: tenant.orgId, userId: tenant.userId, ...changes })
        .onConflictDoUpdate({
          target: [setupProgress.organizationId, setupProgress.userId],
          set: { ...changes, updatedAt: now },
        });
      let setup = await buildSetup(tx, c.env, tenant);
      if (setup.completedAt === null && setup.steps.every((s) => s.done)) {
        await tx
          .update(setupProgress)
          .set({ completedAt: now })
          .where(eq(setupProgress.userId, tenant.userId));
        setup = { ...setup, completedAt: now.toISOString() };
      }
      await insertUsageAudit(tx, tenant, {
        action: 'setup.update',
        outcome: 'allowed',
        entityType: 'setup',
        metadata: { fields: changedFields(body) },
      });
      return { verdict: 'ok', setup } as const;
    });
    if (outcome.verdict === 'ok') return ok(c, outcome.setup, 200);
    if (outcome.verdict === 'invalid_state') {
      return fail(c, 409, 'invalid_state', 'The test call has not completed.');
    }
    return fail(c, 404, 'not_found', 'Call not found.');
  });

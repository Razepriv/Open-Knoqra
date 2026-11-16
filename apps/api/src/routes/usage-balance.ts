import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi';
import { mergeSpendDecisions } from '@knoqra/core';
import { type Tx, withTenant } from '@knoqra/db';
import type { Env } from '../env';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { type UsageBalanceJson, UsageBalanceSchema } from '../lib/m4-schemas';
import { callBillingOf } from '../lib/pricing';
import { insertUsageAudit } from '../lib/usage-audit';
import { pollOrgBalance } from '../services/balance-poll';
import { walletSummary } from '../services/ledger';
import { latestSnapshot, providerSpendDecision, snapshotJson } from '../services/provider-spend';
import { openWallet } from './wallet';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const canManage = (role: string): boolean =>
  role.split(',').some((r) => MANAGER_ROLES.has(r.trim()));

async function balanceBody(tx: Tx, env: Env, orgId: string): Promise<UsageBalanceJson> {
  const now = new Date();
  const wallet = await walletSummary(tx, await openWallet(tx, env, orgId), now, callBillingOf(env));
  const provider = snapshotJson(await latestSnapshot(tx));
  const spend = mergeSpendDecisions(wallet.status, await providerSpendDecision(tx, now));
  return { wallet, provider, spend };
}

async function refuseForbidden(db: AppEnv['Variables']['db'], tenant: Tenant) {
  await withTenant(db, tenant.orgId, (tx) =>
    insertUsageAudit(tx, tenant, {
      action: 'usage.balance.refresh',
      outcome: 'denied',
      entityType: 'provider_balance',
      metadata: { reason: 'role' },
    }),
  );
}

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/usage/balance',
  tags: ['usage'],
  summary: 'The wallet, the latest provider balance snapshot and the merged spend decision',
  security,
  responses: {
    200: {
      description: 'Balance and spend decision',
      content: json(okEnvelope(UsageBalanceSchema)),
    },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/api/v1/usage/balance/refresh',
  tags: ['usage'],
  summary: 'Poll the provider balance now (owners and admins)',
  security,
  responses: {
    200: { description: 'Refreshed balance', content: json(okEnvelope(UsageBalanceSchema)) },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can refresh the provider balance'),
    409: errorResponse('No active organization'),
  },
});

export const usageBalanceRoutes = new OpenAPIHono<AppEnv>();
usageBalanceRoutes
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = await withTenant(db, tenant.orgId, (tx) => balanceBody(tx, c.env, tenant.orgId));
    return ok(c, body, 200);
  })
  .openapi(refreshRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      await refuseForbidden(db, tenant);
      return fail(c, 403, 'forbidden', 'Only owners and admins can refresh the provider balance.');
    }
    const polled = await pollOrgBalance(db, c.env, tenant.orgId);
    const body = await withTenant(db, tenant.orgId, async (tx) => {
      await insertUsageAudit(tx, tenant, {
        action: 'usage.balance.refresh',
        outcome: 'allowed',
        entityType: 'provider_balance',
        metadata: { status: polled?.status ?? 'none' },
      });
      return balanceBody(tx, c.env, tenant.orgId);
    });
    return ok(c, body, 200);
  });

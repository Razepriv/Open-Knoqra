import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { TEN_DLC_STATES, WHATSAPP_STATES } from '@knoqra/core';
import { type PhoneNumberRow, phoneNumber, withTenant } from '@knoqra/db';
import type { NumbersProvider } from '@knoqra/providers';
import { asc, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { NumberConflictError } from '../connectors/store';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { callBillingOf } from '../lib/pricing';
import { openProviderAccess } from '../lib/provider-access';
import { publish } from '../lib/realtime';
import { auditUsageAlone, insertUsageAudit } from '../lib/usage-audit';
import { walletSummary } from '../services/ledger';
import { completePendingOrders } from '../services/number-purchase';
import { assignNumber, syncNumbers } from '../services/numbers';
import { openWallet } from './wallet';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const NUMBER_ID_PATTERN = /^pn_[0-9a-f]{32}$/;
const NUMBER_CONFLICT = 'This number is connected to another workspace';
const MANAGE_MESSAGE = 'Only owners and admins can change numbers.';

export const NumberSchema = z
  .object({
    id: z.string(),
    e164: z.string(),
    provider: z.enum(['fake', 'telnyx', 'plivo']),
    status: z.enum(['active', 'pending', 'inactive']),
    capabilities: z.object({
      voice: z.boolean(),
      sms: z.boolean(),
      mms: z.boolean(),
      whatsapp: z.boolean(),
    }),
    tenDlcStatus: z.enum(TEN_DLC_STATES),
    whatsappStatus: z.enum(WHATSAPP_STATES),
    assignedUse: z.enum(['unassigned', 'calls', 'messages', 'calls_and_messages']),
    lastSyncedAt: z.iso.datetime().nullable(),
  })
  .openapi('PhoneNumber');
type NumberJson = z.infer<typeof NumberSchema>;

const NumberListSchema = z.object({ items: z.array(NumberSchema) }).openapi('PhoneNumberList');
const SyncSchema = z
  .object({
    added: z.number().int(),
    updated: z.number().int(),
    deactivated: z.number().int(),
    items: z.array(NumberSchema),
  })
  .openapi('PhoneNumberSync');
const AssignBody = z
  .object({ assignedUse: z.enum(['unassigned', 'calls', 'messages', 'calls_and_messages']) })
  .openapi('AssignPhoneNumber');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/numbers',
  tags: ['numbers'],
  summary: "The workspace's phone numbers, active first",
  security,
  responses: {
    200: { description: 'Numbers', content: json(okEnvelope(NumberListSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const syncRoute = createRoute({
  method: 'post',
  path: '/api/v1/numbers/sync',
  tags: ['numbers'],
  summary: 'Read the numbers from the provider and update the list',
  security,
  responses: {
    200: { description: 'Sync result', content: json(okEnvelope(SyncSchema)) },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can sync numbers'),
    409: errorResponse('No voice provider is set up, or no active organization'),
    502: errorResponse('The provider did not answer'),
  },
});

const assignRoute = createRoute({
  method: 'patch',
  path: '/api/v1/numbers/{id}',
  tags: ['numbers'],
  summary: 'Choose what a number is used for',
  security,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: json(AssignBody) },
  },
  responses: {
    200: { description: 'The updated number', content: json(okEnvelope(NumberSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can assign numbers'),
    404: errorResponse('No such number'),
    409: errorResponse('The number is inactive, or belongs to another workspace'),
  },
});

const canManage = (role: string): boolean =>
  role.split(',').some((r) => MANAGER_ROLES.has(r.trim()));

export function toNumberJson(row: PhoneNumberRow): NumberJson {
  return {
    id: row.id,
    e164: row.e164,
    provider: row.provider,
    status: row.status,
    capabilities: { voice: row.voice, sms: row.sms, mms: row.mms, whatsapp: row.whatsapp },
    tenDlcStatus: row.tenDlcStatus,
    whatsappStatus: row.whatsappStatus,
    assignedUse: row.assignedUse,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  };
}

/** Active first, then by e164. */
const orderedNumbers = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
  tx
    .select()
    .from(phoneNumber)
    .orderBy(sql`(${phoneNumber.status} = 'active') desc`, asc(phoneNumber.e164));

function refuseForbidden(
  c: Context,
  db: Parameters<typeof auditUsageAlone>[0],
  tenant: Tenant,
  action: 'numbers.sync' | 'numbers.assign',
) {
  return auditUsageAlone(db, tenant, {
    action,
    outcome: 'denied',
    entityType: 'numbers',
    metadata: { reason: 'role' },
  }).then(() => fail(c, 403, 'forbidden', MANAGE_MESSAGE));
}

export const numbers = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const rows = await withTenant(db, tenant.orgId, (tx) => orderedNumbers(tx));
    return ok(c, { items: rows.map(toNumberJson) }, 200);
  })
  .openapi(syncRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) return refuseForbidden(c, db, tenant, 'numbers.sync');
    const access = await withTenant(db, tenant.orgId, (tx) =>
      openProviderAccess(tx, c.env, tenant.orgId),
    );
    if (access.kind === 'none') {
      return fail(
        c,
        409,
        'voice_not_configured',
        'Voice calling is not set up for this workspace.',
      );
    }
    let listed: Awaited<ReturnType<NumbersProvider['listNumbers']>>;
    try {
      // Outside any transaction: the provider can be slow.
      listed = await access.numbers.listNumbers();
    } catch (error) {
      // Name only: never the message, which can carry provider-side detail.
      logger.warn('numbers.sync.upstream_failed', {
        orgId: tenant.orgId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      const name = access.kind === 'plivo' ? 'Plivo' : 'Telnyx';
      return fail(c, 502, 'provider_unavailable', `${name} did not answer. Try again in a minute.`);
    }
    const prefetched: NumbersProvider = { listNumbers: async () => listed };
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const now = new Date();
      const counts = await syncNumbers(tx, tenant.orgId, access.kind, prefetched, now);
      const completed = await completePendingOrders(tx, tenant.orgId, tenant);
      await insertUsageAudit(tx, tenant, {
        action: 'numbers.sync',
        outcome: 'allowed',
        entityType: 'numbers',
        metadata: { ...counts, provider: access.kind },
      });
      const summary =
        completed > 0
          ? await walletSummary(
              tx,
              await openWallet(tx, c.env, tenant.orgId),
              now,
              callBillingOf(c.env),
            )
          : null;
      return { counts, summary, rows: await orderedNumbers(tx) };
    });
    // A completed order may have captured its hold just now.
    if (result.summary) {
      await publish(c.env, tenant.orgId, { type: 'wallet.updated', data: result.summary });
    }
    return ok(c, { ...result.counts, items: result.rows.map(toNumberJson) }, 200);
  })
  .openapi(assignRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) return refuseForbidden(c, db, tenant, 'numbers.assign');
    const { id } = c.req.valid('param');
    const { assignedUse } = c.req.valid('json');
    const wellFormed = NUMBER_ID_PATTERN.test(id);
    try {
      const outcome = await withTenant(db, tenant.orgId, async (tx) => {
        const assigned = wellFormed
          ? await assignNumber(tx, tenant, id, assignedUse)
          : ({ kind: 'not_found' } as const);
        if (assigned.kind === 'ok') {
          await insertUsageAudit(tx, tenant, {
            action: 'numbers.assign',
            outcome: 'allowed',
            entityType: 'numbers',
            entityId: id,
            metadata: { assignedUse },
          });
        }
        return assigned;
      });
      if (outcome.kind === 'ok') return ok(c, toNumberJson(outcome.row), 200);
      if (outcome.kind === 'invalid_state') {
        return fail(c, 409, 'invalid_state', 'Only an active number can be assigned.');
      }
      await auditUsageAlone(db, tenant, {
        action: 'numbers.assign',
        outcome: 'not_found',
        entityType: 'numbers',
        ...(wellFormed ? { entityId: id } : { metadata: { reason: 'malformed_id' } }),
      });
      return fail(c, 404, 'not_found', 'Number not found.');
    } catch (error) {
      if (error instanceof NumberConflictError) {
        await auditUsageAlone(db, tenant, {
          action: 'numbers.assign',
          outcome: 'denied',
          entityType: 'numbers',
          entityId: id,
          metadata: { reason: 'number_conflict' },
        });
        return fail(c, 409, 'validation_error', NUMBER_CONFLICT);
      }
      throw error;
    }
  });

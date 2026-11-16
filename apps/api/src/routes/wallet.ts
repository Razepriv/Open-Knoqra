import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { LEDGER_KINDS } from '@knoqra/core';
import { type LedgerEntryRow, ledgerEntry, type Tx, wallet, withTenant } from '@knoqra/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { auditCallAlone, insertCallAudit } from '../lib/call-audit';
import type { AppEnv, Tenant } from '../lib/context';
import { decodeTimelineCursor, encodeTimelineCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { callBillingOf } from '../lib/pricing';
import { publish } from '../lib/realtime';
import { safeText } from '../lib/schemas';
import { grantsStarterCredit, loadVoiceChoice } from '../lib/voice-provider';
import {
  credit,
  ensureWallet,
  LedgerError,
  type WalletSummary,
  walletSummary,
} from '../services/ledger';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 1024;
const MAX_CREDIT_MICROS = 1_000_000_000;
/** User-chosen credit keys live in their own namespace, so they never collide with system keys. */
const creditKey = (key: string) => `credit:${key}`;

const Micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SpendDecisionSchema = z
  .object({
    outcome: z.enum(['ok', 'warn', 'stop']),
    reason: z.enum([
      'ok',
      'warn_cap',
      'stop_cap',
      'insufficient_funds',
      'provider_low',
      'provider_exhausted',
    ]),
  })
  .openapi('SpendDecision');

export const WalletSummarySchema = z
  .object({
    currency: z.literal('USD'),
    balanceMicros: z.number().int(),
    heldMicros: z.number().int(),
    availableMicros: z.number().int(),
    periodSpendMicros: z.number().int(),
    warnCapMicros: z.number().int().nullable(),
    stopCapMicros: z.number().int().nullable(),
    status: SpendDecisionSchema,
    dialStatus: SpendDecisionSchema,
  })
  .openapi('WalletSummary');

const LedgerEntrySchema = z
  .object({
    id: z.string(),
    kind: z.enum(LEDGER_KINDS),
    balanceDeltaMicros: z.number().int(),
    heldDeltaMicros: z.number().int(),
    reservationId: z.string().nullable(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    note: z.string().nullable(),
    actorUserId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('LedgerEntry');
type LedgerEntryJson = z.infer<typeof LedgerEntrySchema>;

const LedgerPageSchema = z
  .object({ items: z.array(LedgerEntrySchema), nextCursor: z.string().nullable() })
  .openapi('LedgerPage');

const CreditResultSchema = z
  .object({ entry: LedgerEntrySchema, wallet: WalletSummarySchema })
  .openapi('WalletCredit');

const CapsBody = z
  .object({
    warnCapMicros: Micros.nullable().optional(),
    stopCapMicros: Micros.nullable().optional(),
  })
  .openapi('UpdateWalletCaps');

const CreditBody = z
  .object({
    amountMicros: z.number().int().min(1).max(MAX_CREDIT_MICROS),
    note: safeText({ min: 1, max: 200 }),
    idempotencyKey: safeText({ min: 8, max: 80 }),
  })
  .openapi('CreateWalletCredit');

const LedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/wallet',
  tags: ['wallet'],
  summary: "The workspace's balance, holds, monthly spend and caps",
  security,
  responses: {
    200: { description: 'Wallet summary', content: json(okEnvelope(WalletSummarySchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const capsRoute = createRoute({
  method: 'patch',
  path: '/api/v1/wallet/caps',
  tags: ['wallet'],
  summary: 'Set or clear the monthly warn and stop spend caps',
  security,
  request: { body: { required: true, content: json(CapsBody) } },
  responses: {
    200: { description: 'Wallet summary', content: json(okEnvelope(WalletSummarySchema)) },
    400: errorResponse('Invalid caps, or the warn cap is above the stop cap'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can change caps'),
    409: errorResponse('No active organization'),
  },
});

const creditRoute = createRoute({
  method: 'post',
  path: '/api/v1/wallet/credits',
  tags: ['wallet'],
  summary: 'Record money the workspace holds with its voice provider',
  security,
  request: { body: { required: true, content: json(CreditBody) } },
  responses: {
    200: { description: 'Replayed credit', content: json(okEnvelope(CreditResultSchema)) },
    201: { description: 'Recorded credit', content: json(okEnvelope(CreditResultSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can add credit'),
    409: errorResponse(
      'The idempotency key was used for a different entry, or no active organization',
    ),
  },
});

const ledgerRoute = createRoute({
  method: 'get',
  path: '/api/v1/wallet/ledger',
  tags: ['wallet'],
  summary: 'A page of ledger entries, newest first',
  security,
  request: { query: LedgerQuery },
  responses: {
    200: { description: 'Ledger page', content: json(okEnvelope(LedgerPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const canManage = (role: string): boolean =>
  role.split(',').some((r) => MANAGER_ROLES.has(r.trim()));

function toLedgerJson(row: LedgerEntryRow): LedgerEntryJson {
  return {
    id: row.id,
    kind: row.kind,
    balanceDeltaMicros: row.balanceDeltaMicros,
    heldDeltaMicros: row.heldDeltaMicros,
    reservationId: row.reservationId,
    refType: row.refType,
    refId: row.refId,
    note: row.note,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Creates the wallet on first use (with the development starter credit when it applies). */
export async function openWallet(tx: Tx, env: Env, orgId: string) {
  const choice = await loadVoiceChoice(tx, env);
  return ensureWallet(tx, orgId, { starterCredit: grantsStarterCredit(env, choice) });
}

async function currentSummary(tx: Tx, env: Env, orgId: string): Promise<WalletSummary> {
  return walletSummary(tx, await openWallet(tx, env, orgId), new Date(), callBillingOf(env));
}

/** Microsecond-precision ISO text of created_at, so a keyset cursor never rounds a row away. */
const createdKey = sql<string>`to_char(${ledgerEntry.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function forbidden(
  c: Parameters<typeof fail>[0],
  db: Parameters<typeof auditCallAlone>[0],
  tenant: Tenant,
  action: 'wallet.caps.update' | 'wallet.credit.create',
  message: string,
) {
  return auditCallAlone(db, tenant, {
    action,
    outcome: 'denied',
    metadata: { reason: 'role' },
  }).then(() => fail(c, 403, 'forbidden', message));
}

export const walletRoutes = new OpenAPIHono<AppEnv>()
  .openapi(getRoute, async (c) => {
    const { db, tenant } = c.var;
    const summary = await withTenant(db, tenant.orgId, (tx) =>
      currentSummary(tx, c.env, tenant.orgId),
    );
    return ok(c, summary, 200);
  })
  .openapi(capsRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      return forbidden(
        c,
        db,
        tenant,
        'wallet.caps.update',
        'Only owners and admins can change caps.',
      );
    }
    const body = c.req.valid('json');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const current = await openWallet(tx, c.env, tenant.orgId);
      const [locked] = await tx
        .select()
        .from(wallet)
        .where(eq(wallet.id, current.id))
        .for('update');
      const base = locked ?? current;
      const warnCapMicros =
        body.warnCapMicros === undefined ? base.warnCapMicros : body.warnCapMicros;
      const stopCapMicros =
        body.stopCapMicros === undefined ? base.stopCapMicros : body.stopCapMicros;
      if (warnCapMicros !== null && stopCapMicros !== null && warnCapMicros > stopCapMicros) {
        return { invalid: true } as const;
      }
      const [updated] = await tx
        .update(wallet)
        .set({ warnCapMicros, stopCapMicros })
        .where(eq(wallet.id, base.id))
        .returning();
      if (!updated) throw new Error('wallet update returned no row');
      await insertCallAudit(tx, tenant, {
        action: 'wallet.caps.update',
        outcome: 'allowed',
        entityId: updated.id,
        metadata: { warnCapMicros, stopCapMicros },
      });
      return {
        summary: await walletSummary(tx, updated, new Date(), callBillingOf(c.env)),
      } as const;
    });
    if ('invalid' in result) {
      return fail(c, 400, 'validation_error', 'The warn cap must not be above the stop cap.');
    }
    await publish(c.env, tenant.orgId, { type: 'wallet.updated', data: result.summary });
    return ok(c, result.summary, 200);
  })
  .openapi(creditRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      return forbidden(
        c,
        db,
        tenant,
        'wallet.credit.create',
        'Only owners and admins can add credit.',
      );
    }
    const body = c.req.valid('json');
    try {
      const result = await withTenant(db, tenant.orgId, async (tx) => {
        const walletRow = await openWallet(tx, c.env, tenant.orgId);
        const added = await credit(tx, {
          orgId: tenant.orgId,
          amountMicros: body.amountMicros,
          note: body.note,
          idempotencyKey: creditKey(body.idempotencyKey),
          actorUserId: tenant.userId,
        });
        if (added.created) {
          await insertCallAudit(tx, tenant, {
            action: 'wallet.credit.create',
            outcome: 'allowed',
            entityId: added.entry.id,
            metadata: { amountMicros: body.amountMicros },
          });
        }
        return {
          ...added,
          summary: await walletSummary(tx, walletRow, new Date(), callBillingOf(c.env)),
        };
      });
      if (result.created) {
        await publish(c.env, tenant.orgId, { type: 'wallet.updated', data: result.summary });
      }
      const payload = { entry: toLedgerJson(result.entry), wallet: result.summary };
      return result.created ? ok(c, payload, 201) : ok(c, payload, 200);
    } catch (error) {
      if (error instanceof LedgerError && error.code === 'idempotency_conflict') {
        return fail(
          c,
          409,
          'invalid_state',
          'This idempotency key was already used for a different credit.',
        );
      }
      throw error;
    }
  })
  .openapi(ledgerRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: { occurredAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const rows = await withTenant(db, tenant.orgId, async (tx) => {
      await openWallet(tx, c.env, tenant.orgId);
      return tx
        .select({ row: ledgerEntry, key: createdKey })
        .from(ledgerEntry)
        .where(
          and(
            eq(ledgerEntry.organizationId, tenant.orgId),
            cursor
              ? sql`(${ledgerEntry.createdAt}, ${ledgerEntry.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(ledgerEntry.createdAt), desc(ledgerEntry.id))
        .limit(query.limit + 1);
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeTimelineCursor({ occurredAt: last.key, id: last.row.id })
        : null;
    return ok(c, { items: page.map((r) => toLedgerJson(r.row)), nextCursor }, 200);
  });

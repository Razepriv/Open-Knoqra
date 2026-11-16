import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi';
import { reconciliationReport, withTenant } from '@knoqra/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppEnv } from '../lib/context';
import { decodeTimelineCursor, encodeTimelineCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import {
  PageQuerySchema,
  ReconciliationPageSchema,
  ReconciliationReportSchema,
  RunReconciliationSchema,
} from '../lib/m4-schemas';
import { auditUsageAlone } from '../lib/usage-audit';
import { reconcileOrgDay, toReconciliationJson } from '../services/reconcile';

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/usage/reconciliations',
  tags: ['usage'],
  summary: 'A page of daily reconciliation reports, newest first',
  security,
  request: { query: PageQuerySchema },
  responses: {
    200: {
      description: 'Reconciliation page',
      content: json(okEnvelope(ReconciliationPageSchema)),
    },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const runRoute = createRoute({
  method: 'post',
  path: '/api/v1/usage/reconciliations',
  tags: ['usage'],
  summary: 'Reconcile one UTC day against the provider now (owners and admins)',
  security,
  request: { body: { required: true, content: json(RunReconciliationSchema) } },
  responses: {
    201: {
      description: 'Reconciliation report',
      content: json(okEnvelope(ReconciliationReportSchema)),
    },
    400: errorResponse('Invalid body, a future date, or a date more than 90 days ago'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can run a reconciliation'),
    409: errorResponse(
      'The workspace has no voice provider (voice_not_configured), or no active organization',
    ),
  },
});

const MANAGER_ROLES = new Set(['owner', 'admin']);
const MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const canManage = (role: string): boolean =>
  role.split(',').some((r) => MANAGER_ROLES.has(r.trim()));

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** A real calendar day, not after today and not more than 90 days back (UTC). */
function dateInRange(date: string, now: Date): boolean {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || utcDay(parsed) !== date) return false;
  const oldest = utcDay(new Date(now.getTime() - MAX_AGE_DAYS * DAY_MS));
  return date <= utcDay(now) && date >= oldest;
}

/** Microsecond-precision ISO text of created_at, so a keyset cursor never rounds a row away. */
const createdKey = sql<string>`to_char(${reconciliationReport.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const reconciliationRoutes = new OpenAPIHono<AppEnv>();
reconciliationRoutes
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: { occurredAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .select({ row: reconciliationReport, key: createdKey })
        .from(reconciliationReport)
        .where(
          and(
            eq(reconciliationReport.organizationId, tenant.orgId),
            cursor
              ? sql`(${reconciliationReport.createdAt}, ${reconciliationReport.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(reconciliationReport.createdAt), desc(reconciliationReport.id))
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeTimelineCursor({ occurredAt: last.key, id: last.row.id })
        : null;
    return ok(c, { items: page.map((r) => toReconciliationJson(r.row)), nextCursor }, 200);
  })
  .openapi(runRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!canManage(tenant.role)) {
      await auditUsageAlone(db, tenant, {
        action: 'ledger.reconcile',
        outcome: 'denied',
        entityType: 'reconciliation',
        metadata: { reason: 'role' },
      });
      return fail(c, 403, 'forbidden', 'Only owners and admins can run a reconciliation.');
    }
    const { date } = c.req.valid('json');
    if (!dateInRange(date, new Date())) {
      return fail(
        c,
        400,
        'validation_error',
        'The date must be a day from the last 90 days up to today (UTC).',
      );
    }
    const report = await reconcileOrgDay(db, c.env, {
      orgId: tenant.orgId,
      date,
      trigger: 'manual',
      actorUserId: tenant.userId,
    });
    if (!report) {
      return fail(c, 409, 'voice_not_configured', 'Connect a voice provider first.');
    }
    return ok(c, report, 201);
  });

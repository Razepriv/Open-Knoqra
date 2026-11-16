import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi';
import { withTenant } from '@knoqra/db';
import type { AppEnv } from '../lib/context';
import { decodeTimelineCursor, encodeTimelineCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import {
  UsageLedgerPageSchema,
  UsageLedgerQuerySchema,
  UsageRangeQuerySchema,
  UsageSummarySchema,
} from '../lib/m4-schemas';
import { platformFeeRate } from '../lib/pricing';
import { checkRange, parseUtcDay, usageLedgerPage, usageSummary } from '../services/usage-ledger';

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const summaryRoute = createRoute({
  method: 'get',
  path: '/api/v1/usage/summary',
  tags: ['usage'],
  summary: 'Spend per UTC day and channel over an inclusive date range (at most 366 days)',
  security,
  request: { query: UsageRangeQuerySchema },
  responses: {
    200: { description: 'Usage summary', content: json(okEnvelope(UsageSummarySchema)) },
    400: errorResponse('Invalid range: from is after to, or the range exceeds 366 days'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const ledgerRoute = createRoute({
  method: 'get',
  path: '/api/v1/usage/ledger',
  tags: ['usage'],
  summary: 'A filtered page of ledger rows with running balances, newest first',
  security,
  request: { query: UsageLedgerQuerySchema },
  responses: {
    200: { description: 'Ledger page', content: json(okEnvelope(UsageLedgerPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

export const usageRoutes = new OpenAPIHono<AppEnv>();
usageRoutes
  .openapi(summaryRoute, async (c) => {
    const { db, tenant } = c.var;
    const { from, to } = c.req.valid('query');
    const range = checkRange(from, to);
    if (!range.ok) return fail(c, 400, 'validation_error', range.message);
    const summary = await withTenant(db, tenant.orgId, (tx) =>
      usageSummary(tx, tenant.orgId, from, to, range, platformFeeRate(c.env)),
    );
    return ok(c, summary, 200);
  })
  .openapi(ledgerRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let start: Date | null = null;
    let endExclusive: Date | null = null;
    if (query.from !== undefined || query.to !== undefined) {
      const range = checkRange(query.from ?? query.to ?? '', query.to ?? query.from ?? '');
      if (query.from !== undefined && query.to !== undefined && !range.ok) {
        return fail(c, 400, 'validation_error', range.message);
      }
      const startDay = query.from === undefined ? null : parseUtcDay(query.from);
      const endDay = query.to === undefined ? null : parseUtcDay(query.to);
      if ((query.from !== undefined && !startDay) || (query.to !== undefined && !endDay)) {
        return fail(c, 400, 'validation_error', 'Dates must be real YYYY-MM-DD days.');
      }
      if (startDay && endDay && startDay > endDay) {
        return fail(c, 400, 'validation_error', 'The start date must not be after the end date.');
      }
      start = startDay;
      endExclusive = endDay ? new Date(endDay.getTime() + 86_400_000) : null;
    }
    let cursor: { occurredAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const result = await withTenant(db, tenant.orgId, (tx) =>
      usageLedgerPage(tx, tenant.orgId, { query, start, endExclusive, cursor }),
    );
    const nextCursor = result.hasMore && result.last ? encodeTimelineCursor(result.last) : null;
    return ok(c, { items: result.items, nextCursor }, 200);
  });

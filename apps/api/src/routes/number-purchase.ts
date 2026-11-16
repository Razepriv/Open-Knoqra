import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { SpendDecision } from '@knoqra/core';
import { type NumberOrderRow, type NumberQuoteRow, withTenant } from '@knoqra/db';
import type { NumberFeature } from '@knoqra/providers';
import type { Context } from 'hono';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { logger } from '../lib/logger';
import { openProviderAccess } from '../lib/provider-access';
import { safeText } from '../lib/schemas';
import { auditUsageAlone, type UsageAuditAction } from '../lib/usage-audit';
import { createQuote, listOrders, purchaseNumber } from '../services/number-purchase';
import { NumberSchema, toNumberJson } from './numbers';

const AREA_CODE = /^[2-9][0-9]{2}$/;
const REGION = /^[A-Za-z]{2}$/;
const US_E164 = /^\+1[2-9]\d{9}$/;
const FEATURES = ['voice', 'sms', 'mms'] as const;
const OWNER_MESSAGE = 'Only the workspace owner can buy phone numbers.';
const ORDERS_MESSAGE = 'Only owners and admins can see number orders.';
const NOT_CONFIGURED = 'Voice calling is not set up for this workspace.';
const QUOTE_GONE = 'That number was just taken. Pick another.';
const QUOTE_EXPIRED = 'This price has expired. Search again to see the current price.';
const IN_PROGRESS = 'A purchase for this number is already in progress.';
const UNAVAILABLE = 'The number provider did not answer. Try again in a minute.';

const SPEND_MESSAGES: Record<SpendDecision['reason'], string> = {
  insufficient_funds: 'Not enough credit to buy this number.',
  provider_low: 'The provider balance is running low.',
  provider_exhausted: 'The provider balance is too low to buy a number.',
  stop_cap: 'This purchase would pass the monthly spend cap.',
  warn_cap: 'This purchase is over the monthly warning cap.',
  ok: 'Spending is allowed.',
};

/** An empty query value counts as absent. */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const SearchQuery = z.object({
  areaCode: z.preprocess(blankToUndefined, z.string().regex(AREA_CODE).optional()),
  locality: z.preprocess(blankToUndefined, safeText({ min: 1, max: 60 }).optional()),
  region: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(REGION)
      .transform((v) => v.toUpperCase())
      .optional(),
  ),
  features: z.preprocess(
    blankToUndefined,
    z
      .string()
      .transform((v) => v.split(',').map((f) => f.trim()))
      .pipe(z.array(z.enum(FEATURES)).min(1).max(3))
      .optional(),
  ),
});

const AvailableSchema = z
  .object({
    e164: z.string(),
    locality: z.string().nullable(),
    region: z.string().nullable(),
    capabilities: z.object({ voice: z.boolean(), sms: z.boolean(), mms: z.boolean() }),
    upfrontMicros: z.number().int(),
    monthlyMicros: z.number().int(),
    currency: z.enum(['USD']),
  })
  .openapi('AvailableNumber');
const AvailableListSchema = z
  .object({ items: z.array(AvailableSchema) })
  .openapi('AvailableNumberList');

const QuoteBody = z.object({ e164: z.string().regex(US_E164) }).openapi('NumberQuoteRequest');
const QuoteSchema = z
  .object({
    id: z.string(),
    e164: z.string(),
    upfrontMicros: z.number().int(),
    monthlyMicros: z.number().int(),
    totalMicros: z.number().int(),
    currency: z.enum(['USD']),
    expiresAt: z.iso.datetime(),
  })
  .openapi('NumberQuote');

const PurchaseBody = z
  .object({
    quoteId: z.string().regex(/^nq_[0-9a-f]{32}$/),
    idempotencyKey: safeText({ min: 8, max: 80 }),
  })
  .openapi('NumberPurchaseRequest');
const OrderSchema = z
  .object({
    id: z.string(),
    e164: z.string(),
    status: z.enum(['pending', 'completed', 'failed']),
    upfrontMicros: z.number().int(),
    monthlyMicros: z.number().int(),
    failureCode: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('NumberOrder');
// A union, not `.nullable()`: that emits `allOf` with a nullable object, which the client
// generator turns into an unsatisfiable intersection.
const PurchaseSchema = z
  .object({ order: OrderSchema, number: z.union([NumberSchema, z.null()]) })
  .openapi('NumberPurchase');
const OrderListSchema = z.object({ items: z.array(OrderSchema) }).openapi('NumberOrderList');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const availableRoute = createRoute({
  method: 'get',
  path: '/api/v1/numbers/available',
  tags: ['numbers'],
  summary: 'Search phone numbers available to buy',
  security,
  request: { query: SearchQuery },
  responses: {
    200: { description: 'Available numbers', content: json(okEnvelope(AvailableListSchema)) },
    400: errorResponse('Invalid search'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only the owner can search'),
    409: errorResponse('No voice provider is set up'),
    502: errorResponse('The provider did not answer'),
  },
});

const quoteRoute = createRoute({
  method: 'post',
  path: '/api/v1/numbers/quotes',
  tags: ['numbers'],
  summary: 'Confirm the current price of one number',
  security,
  request: { body: { required: true, content: json(QuoteBody) } },
  responses: {
    201: { description: 'The quote', content: json(okEnvelope(QuoteSchema)) },
    400: errorResponse('Invalid number'),
    401: errorResponse('No valid session'),
    403: errorResponse('Only the owner can quote'),
    409: errorResponse('The number is no longer available, or no provider is set up'),
    502: errorResponse('The provider did not answer'),
  },
});

const purchaseRoute = createRoute({
  method: 'post',
  path: '/api/v1/numbers/purchase',
  tags: ['numbers'],
  summary: 'Buy a quoted number, charging the wallet once per idempotency key',
  security,
  request: { body: { required: true, content: json(PurchaseBody) } },
  responses: {
    200: {
      description: 'A replay of an earlier purchase',
      content: json(okEnvelope(PurchaseSchema)),
    },
    201: { description: 'The purchase', content: json(okEnvelope(PurchaseSchema)) },
    400: errorResponse('Invalid body'),
    401: errorResponse('No valid session'),
    402: errorResponse('Spending is blocked'),
    403: errorResponse('Only the owner can buy'),
    409: errorResponse('The quote is expired or used, or no provider is set up'),
  },
});

const ordersRoute = createRoute({
  method: 'get',
  path: '/api/v1/numbers/orders',
  tags: ['numbers'],
  summary: 'The newest number orders',
  security,
  responses: {
    200: { description: 'Orders', content: json(okEnvelope(OrderListSchema)) },
    401: errorResponse('No valid session'),
    403: errorResponse('Only owners and admins can see orders'),
  },
});

const hasRole = (role: string, allowed: readonly string[]): boolean =>
  role.split(',').some((r) => allowed.includes(r.trim()));

function refuse(
  c: Context,
  db: Parameters<typeof auditUsageAlone>[0],
  tenant: Tenant,
  action: UsageAuditAction,
  message: string,
) {
  return auditUsageAlone(db, tenant, {
    action,
    outcome: 'denied',
    entityType: 'numbers',
    metadata: { reason: 'role' },
  }).then(() => fail(c, 403, 'forbidden', message));
}

const toQuoteJson = (q: NumberQuoteRow) => ({
  id: q.id,
  e164: q.e164,
  upfrontMicros: q.upfrontMicros,
  monthlyMicros: q.monthlyMicros,
  totalMicros: q.upfrontMicros + q.monthlyMicros,
  currency: q.currency,
  expiresAt: q.expiresAt.toISOString(),
});

const toOrderJson = (o: NumberOrderRow) => ({
  id: o.id,
  e164: o.e164,
  status: o.status,
  upfrontMicros: o.upfrontMicros,
  monthlyMicros: o.monthlyMicros,
  failureCode: o.failureCode,
  createdAt: o.createdAt.toISOString(),
});

const isRangeError = (error: unknown): boolean => error instanceof RangeError;

/** A provider failure other than bad input: logged by name only, answered as 502. */
function upstreamFailure(c: Context, orgId: string, event: string, error: unknown) {
  logger.warn(event, {
    orgId,
    errorName: error instanceof Error ? error.name : 'unknown',
  });
  return fail(c, 502, 'provider_unavailable', UNAVAILABLE);
}

export const numberPurchase = new OpenAPIHono<AppEnv>()
  .openapi(availableRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!hasRole(tenant.role, ['owner'])) {
      return refuse(c, db, tenant, 'numbers.search', OWNER_MESSAGE);
    }
    const query = c.req.valid('query');
    const access = await withTenant(db, tenant.orgId, (tx) =>
      openProviderAccess(tx, c.env, tenant.orgId),
    );
    if (access.kind === 'none') return fail(c, 409, 'voice_not_configured', NOT_CONFIGURED);
    const features: NumberFeature[] = query.features ?? ['voice'];
    try {
      const items = await access.purchase.searchAvailableNumbers({
        country: 'US',
        areaCode: query.areaCode,
        locality: query.locality,
        region: query.region,
        features,
      });
      return ok(c, { items }, 200);
    } catch (error) {
      if (isRangeError(error))
        return fail(c, 400, 'validation_error', 'Check the search and try again.');
      return upstreamFailure(c, tenant.orgId, 'numbers.search.upstream_failed', error);
    }
  })
  .openapi(quoteRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!hasRole(tenant.role, ['owner'])) {
      return refuse(c, db, tenant, 'numbers.quote', OWNER_MESSAGE);
    }
    const { e164 } = c.req.valid('json');
    const access = await withTenant(db, tenant.orgId, (tx) =>
      openProviderAccess(tx, c.env, tenant.orgId),
    );
    if (access.kind === 'none') return fail(c, 409, 'voice_not_configured', NOT_CONFIGURED);
    try {
      const outcome = await createQuote(db, tenant, access, e164, new Date());
      if (outcome.kind === 'unavailable') return fail(c, 409, 'quote_invalid', QUOTE_GONE);
      if (outcome.kind === 'in_progress') return fail(c, 409, 'quote_invalid', IN_PROGRESS);
      return ok(c, toQuoteJson(outcome.quote), 201);
    } catch (error) {
      if (isRangeError(error)) return fail(c, 400, 'validation_error', 'Enter a valid US number.');
      return upstreamFailure(c, tenant.orgId, 'numbers.quote.upstream_failed', error);
    }
  })
  .openapi(purchaseRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!hasRole(tenant.role, ['owner'])) {
      return refuse(c, db, tenant, 'numbers.purchase', OWNER_MESSAGE);
    }
    const body = c.req.valid('json');
    const access = await withTenant(db, tenant.orgId, (tx) =>
      openProviderAccess(tx, c.env, tenant.orgId),
    );
    if (access.kind === 'none') return fail(c, 409, 'voice_not_configured', NOT_CONFIGURED);
    const outcome = await purchaseNumber(db, c.env, tenant, access, body);
    if (outcome.kind === 'key_reused') {
      return fail(
        c,
        409,
        'validation_error',
        'This purchase key was already used for another number.',
      );
    }
    if (outcome.kind === 'quote_invalid') return fail(c, 409, 'quote_invalid', QUOTE_EXPIRED);
    if (outcome.kind === 'in_progress') return fail(c, 409, 'quote_invalid', IN_PROGRESS);
    if (outcome.kind === 'spend_blocked') {
      return fail(c, 402, 'spend_blocked', SPEND_MESSAGES[outcome.decision.reason]);
    }
    return ok(
      c,
      {
        order: toOrderJson(outcome.order),
        number: outcome.number ? toNumberJson(outcome.number) : null,
      },
      outcome.kind === 'replay' ? 200 : 201,
    );
  })
  .openapi(ordersRoute, async (c) => {
    const { db, tenant } = c.var;
    if (!hasRole(tenant.role, ['owner', 'admin'])) {
      return refuse(c, db, tenant, 'numbers.orders', ORDERS_MESSAGE);
    }
    const rows = await listOrders(db, tenant);
    return ok(c, { items: rows.map(toOrderJson) }, 200);
  });

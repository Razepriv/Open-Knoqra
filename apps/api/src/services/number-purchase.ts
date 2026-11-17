import type { SpendDecision } from '@knoqra/core';
import { newId } from '@knoqra/core';
import {
  type Database,
  type NumberOrderRow,
  type NumberQuoteRow,
  numberOrder,
  numberQuote,
  type PhoneNumberRow,
  phoneNumber,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { type NumberOrderResult, type NumbersProvider, ProviderApiError } from '@knoqra/providers';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { NumberConflictError } from '../connectors/store';
import type { Env } from '../env';
import { isUniqueViolation } from '../lib/contact-fields';
import type { Tenant } from '../lib/context';
import { logger } from '../lib/logger';
import { callBillingOf } from '../lib/pricing';
import { openProviderAccess, type ProviderAccess } from '../lib/provider-access';
import { publish } from '../lib/realtime';
import { insertUsageAudit } from '../lib/usage-audit';
import { openWallet } from '../routes/wallet';
import { reserve, settleReservation, walletSummary } from './ledger';
import { assignNumber, syncNumbers } from './numbers';
import { providerSpendDecision } from './provider-spend';

export const QUOTE_TTL_MS = 10 * 60 * 1000;
const ORDERS_PAGE = 20;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;
const GENERIC_FAILURE = 'order_failed';
/** The provider's answer was lost or unreadable: the order is pending with its hold open. */
const UNCONFIRMED = 'unconfirmed';
/** At most one pending or completed order per number in an organization (the schema backstop). */
const OPEN_ORDER_UNIQUE = 'number_order_open_e164_unique';
/** Ambiguous provider statuses: the order may still have been taken, so they are not refusals. */
const AMBIGUOUS_STATUSES: ReadonlySet<number> = new Set([408, 429]);

type ActiveAccess = Exclude<ProviderAccess, { kind: 'none' }>;

const holdKey = (key: string) => `number-order:${key}:hold`;
const settleKey = (key: string) => `number-order:${key}:settle`;

async function advisoryLock(tx: Tx, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);
}

export type QuoteOutcome =
  | { kind: 'ok'; quote: NumberQuoteRow }
  | { kind: 'unavailable' }
  | { kind: 'in_progress' };

/** Whether this organization already has a pending or completed order for the number. */
async function hasOpenOrder(tx: Tx, e164: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: numberOrder.id })
    .from(numberOrder)
    .where(and(eq(numberOrder.e164, e164), ne(numberOrder.status, 'failed')))
    .limit(1);
  return open !== undefined;
}

/**
 * Reads the price for exactly this number from the provider (outside any transaction) and stores
 * it as a quote. A number with an open order in this organization is not quoted again. Provider
 * errors propagate to the caller.
 */
export async function createQuote(
  db: Database,
  tenant: Tenant,
  access: ActiveAccess,
  e164: string,
  now: Date,
): Promise<QuoteOutcome> {
  if (await withTenant(db, tenant.orgId, (tx) => hasOpenOrder(tx, e164))) {
    return { kind: 'in_progress' };
  }
  const priced = await access.purchase.quoteNumber(e164);
  if (!priced || priced.e164 !== e164 || priced.upfrontMicros + priced.monthlyMicros <= 0) {
    return { kind: 'unavailable' };
  }
  const [quote] = await withTenant(db, tenant.orgId, (tx) =>
    tx
      .insert(numberQuote)
      .values({
        organizationId: tenant.orgId,
        provider: access.kind,
        e164: priced.e164,
        upfrontMicros: priced.upfrontMicros,
        monthlyMicros: priced.monthlyMicros,
        currency: priced.currency,
        expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
        createdBy: tenant.userId,
      })
      .returning(),
  );
  if (!quote) throw new Error('quote insert returned no row');
  return { kind: 'ok', quote };
}

export interface PurchaseInput {
  quoteId: string;
  idempotencyKey: string;
}

export type PurchaseOutcome =
  | { kind: 'replay' | 'created'; order: NumberOrderRow; number: PhoneNumberRow | null }
  | { kind: 'quote_invalid' }
  | { kind: 'in_progress' }
  | { kind: 'key_reused' }
  | { kind: 'spend_blocked'; decision: SpendDecision };

class SpendRefused extends Error {
  constructor(readonly decision: SpendDecision) {
    super('spend refused');
  }
}

/** Another open order holds this number: thrown so the hold rolls back. */
class OrderInProgress extends Error {
  constructor() {
    super('order in progress');
  }
}

type Reserved =
  | { kind: 'reserved'; order: NumberOrderRow }
  | { kind: 'replay'; order: NumberOrderRow }
  | { kind: 'quote_invalid' }
  | { kind: 'in_progress' }
  | { kind: 'key_reused' };

const orderByKey = async (tx: Tx, key: string) => {
  const [row] = await tx
    .select()
    .from(numberOrder)
    .where(eq(numberOrder.idempotencyKey, key))
    .limit(1);
  return row;
};

const numberOf = async (tx: Tx, order: NumberOrderRow) => {
  if (order.status !== 'completed') return null;
  const [row] = await tx
    .select()
    .from(phoneNumber)
    .where(eq(phoneNumber.e164, order.e164))
    .limit(1);
  return row ?? null;
};

/** Holds the full price and records a pending order, atomically and once per key and quote. */
async function holdAndRecord(
  db: Database,
  env: Env,
  tenant: Tenant,
  access: ActiveAccess,
  input: PurchaseInput,
  now: Date,
): Promise<Reserved> {
  return withTenant(db, tenant.orgId, async (tx): Promise<Reserved> => {
    await advisoryLock(tx, `number-order:${tenant.orgId}:${input.idempotencyKey}`);
    await advisoryLock(tx, `number-quote:${tenant.orgId}:${input.quoteId}`);
    const existing = await orderByKey(tx, input.idempotencyKey);
    if (existing) {
      return existing.quoteId === input.quoteId
        ? { kind: 'replay', order: existing }
        : { kind: 'key_reused' };
    }

    const [quote] = await tx
      .select()
      .from(numberQuote)
      .where(eq(numberQuote.id, input.quoteId))
      .limit(1);
    if (!quote || quote.expiresAt <= now || quote.provider !== access.kind) {
      return { kind: 'quote_invalid' };
    }
    const [used] = await tx
      .select({ id: numberOrder.id })
      .from(numberOrder)
      .where(eq(numberOrder.quoteId, quote.id))
      .limit(1);
    if (used) return { kind: 'quote_invalid' };
    if (await hasOpenOrder(tx, quote.e164)) return { kind: 'in_progress' };

    const total = quote.upfrontMicros + quote.monthlyMicros;
    const orderId = newId('no');
    await openWallet(tx, env, tenant.orgId);
    // A free order (a number a plan includes) holds nothing: there is nothing to capture.
    let reservationId: string | null = null;
    if (total > 0) {
      const held = await reserve(tx, {
        orgId: tenant.orgId,
        amountMicros: total,
        idempotencyKey: holdKey(input.idempotencyKey),
        refType: 'number_order',
        refId: orderId,
        actorUserId: tenant.userId,
      });
      if ('refused' in held) throw new SpendRefused(held.refused);
      reservationId = held.entry.id;
    }
    const providerDecision = await providerSpendDecision(tx, now);
    // Throwing rolls the transaction back, so the hold above is not kept.
    if (providerDecision.outcome === 'stop') throw new SpendRefused(providerDecision);

    let order: NumberOrderRow | undefined;
    try {
      [order] = await tx
        .insert(numberOrder)
        .values({
          id: orderId,
          organizationId: tenant.orgId,
          quoteId: quote.id,
          provider: quote.provider,
          e164: quote.e164,
          idempotencyKey: input.idempotencyKey,
          status: 'pending',
          upfrontMicros: quote.upfrontMicros,
          monthlyMicros: quote.monthlyMicros,
          reservationId,
          createdBy: tenant.userId,
        })
        .returning();
    } catch (error) {
      // A concurrent purchase of the same number (another quote and key) committed first; the
      // throw rolls the hold back.
      if (isUniqueViolation(error, OPEN_ORDER_UNIQUE)) throw new OrderInProgress();
      throw error;
    }
    if (!order) throw new Error('order insert returned no row');
    return { kind: 'reserved', order };
  });
}

interface ProviderAnswer {
  status: NumberOrderResult['status'];
  providerOrderId: string | null;
  failureCode: string | null;
  /**
   * False when the outcome is unknown (a network error, a timeout, a 5xx or an unreadable body):
   * the provider may have taken and billed the order, so the hold stays open and nothing settles.
   */
  confirmed: boolean;
}

/**
 * Only a 4xx answer proves the provider refused the order, so nothing can have been billed. A 408
 * (timeout) or 429 (rate limit) proves nothing: the order may still have been taken.
 */
function isDefiniteRefusal(error: unknown): error is ProviderApiError {
  return (
    error instanceof ProviderApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !AMBIGUOUS_STATUSES.has(error.status) &&
    error.code !== 'invalid_response'
  );
}

/**
 * The provider call, outside any transaction. An explicit `failed` status or a 4xx refusal is a
 * failed order with a safe code; any other throw is an unconfirmed order that keeps its hold.
 */
async function placeOrder(access: ActiveAccess, order: NumberOrderRow): Promise<ProviderAnswer> {
  try {
    const result = await access.purchase.orderNumber({
      e164: order.e164,
      connectionId: access.connectionId,
    });
    return {
      status: result.status,
      providerOrderId: result.providerOrderId,
      failureCode: result.status === 'failed' ? GENERIC_FAILURE : null,
      confirmed: true,
    };
  } catch (error) {
    const refused = isDefiniteRefusal(error);
    // Name only: never the message, which can carry provider-side detail.
    logger.warn('numbers.purchase.provider_failed', {
      orgId: order.organizationId,
      errorName: error instanceof Error ? error.name : 'unknown',
      refused,
    });
    if (refused) {
      return {
        status: 'failed',
        providerOrderId: null,
        failureCode: SAFE_CODE.test(error.code) ? error.code : GENERIC_FAILURE,
        confirmed: true,
      };
    }
    return { status: 'pending', providerOrderId: null, failureCode: UNCONFIRMED, confirmed: false };
  }
}

interface OrderOutcome {
  status: 'pending' | 'failed';
  failureCode: string | null;
}

/**
 * Settles the hold for a confirmed answer and reads the outcome off the ledger entry rather than
 * the answer: a sync may already have captured this hold under the same settle key. A capture is
 * never reported as failed and a release never as bought. An unconfirmed answer settles nothing.
 */
async function settleHold(
  tx: Tx,
  orgId: string,
  order: NumberOrderRow,
  answer: ProviderAnswer,
  key: string,
): Promise<OrderOutcome> {
  if (!answer.confirmed) return { status: 'pending', failureCode: answer.failureCode };
  if (order.reservationId === null) {
    // A free order: nothing held, so nothing to settle.
    return answer.status === 'failed'
      ? { status: 'failed', failureCode: answer.failureCode ?? GENERIC_FAILURE }
      : { status: 'pending', failureCode: null };
  }
  const entry = await settleReservation(tx, {
    orgId,
    reservationId: order.reservationId,
    costMicros: answer.status === 'failed' ? 0 : order.upfrontMicros + order.monthlyMicros,
    idempotencyKey: settleKey(key),
    refType: 'number_order',
    refId: order.id,
  });
  if (entry.kind === 'release') {
    return { status: 'failed', failureCode: answer.failureCode ?? GENERIC_FAILURE };
  }
  return { status: 'pending', failureCode: null };
}

/**
 * The order as another path left it. Records the provider's order id when that path had none;
 * the status stays as it is.
 */
async function currentOrder(
  tx: Tx,
  orderId: string,
  providerOrderId: string | null,
): Promise<NumberOrderRow> {
  if (providerOrderId) {
    await tx
      .update(numberOrder)
      .set({ providerOrderId })
      .where(
        and(
          eq(numberOrder.id, orderId),
          ne(numberOrder.status, 'failed'),
          isNull(numberOrder.providerOrderId),
        ),
      );
  }
  const [row] = await tx.select().from(numberOrder).where(eq(numberOrder.id, orderId)).limit(1);
  if (!row) throw new Error('order reload returned no row');
  return row;
}

/**
 * Captures the charge (or releases it on a definite failure), records the outcome and audits it.
 * An unconfirmed answer settles nothing: the hold stays until a sync finds the number. A bought
 * order is recorded `pending` until a sync lists its number and assigns it
 * (`completePendingOrders`), so a failed sync leaves it for the next one to finish. The status
 * write applies only to a still-pending order: when a concurrent sync already completed it, the
 * order is returned as it now stands.
 */
async function settleOrder(
  db: Database,
  env: Env,
  tenant: Tenant,
  order: NumberOrderRow,
  answer: ProviderAnswer,
  key: string,
) {
  return withTenant(db, tenant.orgId, async (tx) => {
    const outcome = await settleHold(tx, tenant.orgId, order, answer, key);
    const [updated] = await tx
      .update(numberOrder)
      .set({ ...outcome, providerOrderId: answer.providerOrderId })
      .where(and(eq(numberOrder.id, order.id), eq(numberOrder.status, 'pending')))
      .returning();
    const current = updated ?? (await currentOrder(tx, order.id, answer.providerOrderId));
    await insertUsageAudit(tx, tenant, {
      action: 'numbers.purchase',
      outcome: 'allowed',
      entityType: 'number_order',
      entityId: current.id,
      metadata: {
        e164: current.e164,
        upfrontMicros: current.upfrontMicros,
        monthlyMicros: current.monthlyMicros,
        status: answer.status,
      },
    });
    const summary = await walletSummary(
      tx,
      await openWallet(tx, env, tenant.orgId),
      new Date(),
      callBillingOf(env),
    );
    return { order: current, summary };
  });
}

/** Makes a just-bought number calls-and-messages and audits it like a manual assign. */
async function assignBought(
  tx: Tx,
  orgId: string,
  actor: Tenant | null,
  numberId: string,
): Promise<void> {
  try {
    // A savepoint, so a conflict rolls back the assign only and the sync is kept.
    const assigned = await tx.transaction((savepoint) =>
      assignNumber(savepoint, { orgId }, numberId, 'calls_and_messages'),
    );
    if (assigned.kind !== 'ok') return;
    await insertUsageAudit(tx, actor, {
      action: 'numbers.assign',
      outcome: 'allowed',
      entityType: 'numbers',
      entityId: numberId,
      orgId,
      metadata: { assignedUse: 'calls_and_messages', source: 'purchase' },
    });
  } catch (error) {
    if (!(error instanceof NumberConflictError)) throw error;
    logger.warn('numbers.pending_order.assign_conflict', { orgId });
  }
}

/**
 * Completes every pending order whose number the provider now lists as active: settles its hold
 * (idempotent on the order's settle key, so a captured order keeps its one capture and an
 * unconfirmed hold is captured now), marks it completed and assigns the number
 * calls-and-messages. At most one order per number completes (the open-order index allows only
 * one anyway). An order whose hold was released, or that another path already moved off
 * `pending`, is left alone: only the path whose status write flips the order assigns and audits.
 * Run in the transaction that just called `syncNumbers`: that already holds
 * the per-organization numbers lock, so the lock order is numbers, then wallet. `actor` is null
 * for the cron. Returns how many orders completed; the caller publishes `wallet.updated` after
 * the commit when that is above zero.
 */
export async function completePendingOrders(
  tx: Tx,
  orgId: string,
  actor: Tenant | null,
): Promise<number> {
  const pending = await tx
    .select()
    .from(numberOrder)
    .where(eq(numberOrder.status, 'pending'))
    .orderBy(numberOrder.createdAt);
  const seen = new Set<string>();
  let completed = 0;
  for (const order of pending) {
    // Defensive: the open-order index already keeps a number to one pending order.
    if (seen.has(order.e164)) {
      logger.warn('numbers.pending_order.duplicate_number', { orgId });
      continue;
    }
    seen.add(order.e164);
    const [row] = await tx
      .select()
      .from(phoneNumber)
      .where(and(eq(phoneNumber.e164, order.e164), eq(phoneNumber.status, 'active')))
      .limit(1);
    if (!row) continue;
    // A free order holds nothing: it completes once its number is active.
    if (order.reservationId !== null) {
      const entry = await settleReservation(tx, {
        orgId,
        reservationId: order.reservationId,
        costMicros: order.upfrontMicros + order.monthlyMicros,
        idempotencyKey: settleKey(order.idempotencyKey),
        refType: 'number_order',
        refId: order.id,
      });
      // The purchase path released this hold first: nothing was charged, so nothing completes.
      if (entry.kind !== 'capture') continue;
    }
    const [flipped] = await tx
      .update(numberOrder)
      .set({ status: 'completed', failureCode: null })
      .where(and(eq(numberOrder.id, order.id), eq(numberOrder.status, 'pending')))
      .returning({ id: numberOrder.id });
    if (!flipped) continue;
    completed += 1;
    await assignBought(tx, orgId, actor, row.id);
  }
  return completed;
}

/**
 * Lists the provider's numbers (outside any transaction), syncs them and completes the pending
 * orders whose number is now active, then publishes the wallet when an order completed. Provider
 * errors propagate.
 */
export async function syncNumbersAndOrders(
  db: Database,
  env: Env,
  orgId: string,
  actor: Tenant | null,
  opts: { fetch?: typeof fetch } = {},
): Promise<number> {
  const access = await withTenant(db, orgId, (tx) =>
    openProviderAccess(tx, env, orgId, opts.fetch ? { fetch: opts.fetch } : {}),
  );
  if (access.kind === 'none') return 0;
  const listed = await access.numbers.listNumbers();
  const prefetched: NumbersProvider = { listNumbers: async () => listed };
  const now = new Date();
  const done = await withTenant(db, orgId, async (tx) => {
    await syncNumbers(tx, orgId, access.kind, prefetched, now);
    const completed = await completePendingOrders(tx, orgId, actor);
    const summary =
      completed > 0
        ? await walletSummary(tx, await openWallet(tx, env, orgId), now, callBillingOf(env))
        : null;
    return { completed, summary };
  });
  if (done.summary) await publish(env, orgId, { type: 'wallet.updated', data: done.summary });
  return done.completed;
}

/** The cron step: syncs an organization's numbers only while it has a pending number order. */
export async function completeOrgPendingOrders(
  db: Database,
  env: Env,
  orgId: string,
): Promise<number> {
  const [pending] = await withTenant(db, orgId, (tx) =>
    tx
      .select({ id: numberOrder.id })
      .from(numberOrder)
      .where(eq(numberOrder.status, 'pending'))
      .limit(1),
  );
  if (!pending) return 0;
  return syncNumbersAndOrders(db, env, orgId, null);
}

/**
 * Brings a bought (or provider-pending) number into the list, completing and assigning its order
 * once the number is active. The order is already settled, so nothing here may fail the purchase:
 * a problem is logged and the order stays pending for the next sync (the cron runs one).
 */
async function syncAfterPurchase(db: Database, env: Env, tenant: Tenant): Promise<void> {
  try {
    await syncNumbersAndOrders(db, env, tenant.orgId, tenant);
  } catch (error) {
    logger.error('numbers.purchase.adopt_failed', {
      orgId: tenant.orgId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Buys a quoted number: hold, provider order, capture or release. Idempotent on the key: a retry
 * returns the first order and never reserves or orders twice.
 */
export async function purchaseNumber(
  db: Database,
  env: Env,
  tenant: Tenant,
  access: ActiveAccess,
  input: PurchaseInput,
): Promise<PurchaseOutcome> {
  const replay = await withTenant(db, tenant.orgId, async (tx) => {
    const existing = await orderByKey(tx, input.idempotencyKey);
    return existing ? { order: existing, number: await numberOf(tx, existing) } : null;
  });
  if (replay) {
    return replay.order.quoteId === input.quoteId
      ? { kind: 'replay', ...replay }
      : { kind: 'key_reused' };
  }

  let held: Reserved;
  try {
    held = await holdAndRecord(db, env, tenant, access, input, new Date());
  } catch (error) {
    if (error instanceof SpendRefused) return { kind: 'spend_blocked', decision: error.decision };
    if (error instanceof OrderInProgress) return { kind: 'in_progress' };
    throw error;
  }
  if (held.kind === 'quote_invalid' || held.kind === 'in_progress' || held.kind === 'key_reused') {
    return held;
  }
  if (held.kind === 'replay') {
    const number = await withTenant(db, tenant.orgId, (tx) => numberOf(tx, held.order));
    return { kind: 'replay', order: held.order, number };
  }

  const answer = await placeOrder(access, held.order);
  const settled = await settleOrder(db, env, tenant, held.order, answer, input.idempotencyKey);
  await publish(env, tenant.orgId, { type: 'wallet.updated', data: settled.summary });
  if (settled.order.status === 'failed') {
    return { kind: 'created', order: settled.order, number: null };
  }
  if (settled.order.status === 'completed') {
    // A concurrent sync already completed and assigned it.
    const number = await withTenant(db, tenant.orgId, (tx) => numberOf(tx, settled.order));
    return { kind: 'created', order: settled.order, number };
  }
  await syncAfterPurchase(db, env, tenant);
  const current = await withTenant(db, tenant.orgId, async (tx) => {
    const order = (await orderByKey(tx, input.idempotencyKey)) ?? settled.order;
    return { order, number: await numberOf(tx, order) };
  });
  return { kind: 'created', ...current };
}

/** The newest orders of the organization. */
export function listOrders(db: Database, tenant: Tenant): Promise<NumberOrderRow[]> {
  return withTenant(db, tenant.orgId, (tx) =>
    tx.select().from(numberOrder).orderBy(desc(numberOrder.createdAt)).limit(ORDERS_PAGE),
  );
}

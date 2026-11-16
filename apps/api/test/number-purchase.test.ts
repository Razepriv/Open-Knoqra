import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  auditEvent,
  ledgerEntry,
  member,
  numberOrder,
  numberQuote,
  providerBalanceSnapshot,
  wallet,
  withTenant,
} from '@knoqra/db';
import {
  FakeProvider,
  type NumberOrderResult,
  type ProviderNumber,
  TelnyxApiError,
} from '@knoqra/providers';
import { and, desc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { balancePollOrg } from '../src/cron/jobs';
import type { Env } from '../src/env';
import type { Tenant } from '../src/lib/context';
import { openProviderAccess } from '../src/lib/provider-access';
import { purchaseNumber, syncNumbersAndOrders } from '../src/services/number-purchase';
import { get, NO_PURCHASE, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Available = { e164: string; upfrontMicros: number; monthlyMicros: number };
type QuoteJson = {
  id: string;
  e164: string;
  upfrontMicros: number;
  monthlyMicros: number;
  totalMicros: number;
  currency: string;
  expiresAt: string;
};
type OrderJson = {
  id: string;
  e164: string;
  status: string;
  upfrontMicros: number;
  monthlyMicros: number;
  failureCode: string | null;
};
type PurchaseJson = { order: OrderJson; number: { id: string; assignedUse: string } | null };
type Org = { cookie: string; orgId: string };

afterEach(() => vi.restoreAllMocks());

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  const ctx = createExecutionContext();
  const response = await app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env as unknown as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const search = (cookie: string, query = '?areaCode=202') =>
  request(`/api/v1/numbers/available${query}`, cookie);
const quoteOf = (cookie: string, e164: string) =>
  request('/api/v1/numbers/quotes', cookie, 'POST', { e164 });
const buy = (cookie: string, quoteId: string, idempotencyKey: string) =>
  request('/api/v1/numbers/purchase', cookie, 'POST', { quoteId, idempotencyKey });
const key = () => `idem-${crypto.randomUUID()}`;

async function newQuote(cookie: string, e164 = '+12025550150'): Promise<QuoteJson> {
  const r = await quoteOf(cookie, e164);
  expect(r.status).toBe(201);
  return ((await r.json()) as Envelope<QuoteJson>).data as QuoteJson;
}

async function available(cookie: string): Promise<number> {
  const r = await get('/api/v1/wallet', cookie);
  return ((await r.json()) as Envelope<{ availableMicros: number }>).data?.availableMicros ?? NaN;
}

const ledgerOf = (orgId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.organizationId, orgId))
      .orderBy(ledgerEntry.createdAt),
  );

const setRole = (orgId: string, role: string) =>
  withAdminDb((db) => db.update(member).set({ role }).where(eq(member.organizationId, orgId)));

const ordersOf = (orgId: string) =>
  withAdminDb((db) => db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)));

async function heldOf(cookie: string): Promise<number> {
  const r = await get('/api/v1/wallet', cookie);
  return ((await r.json()) as Envelope<{ heldMicros: number }>).data?.heldMicros ?? NaN;
}

const assignAudits = (orgId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.action, 'numbers.assign'))),
  );

/** Makes the fake provider list `e164` (with `status`) on top of its usual numbers. */
function listAlso(e164: string, status: ProviderNumber['status']) {
  const original = FakeProvider.prototype.listNumbers;
  return vi.spyOn(FakeProvider.prototype, 'listNumbers').mockImplementation(async function (
    this: FakeProvider,
  ) {
    const base = await original.call(this);
    return [
      ...base.filter((n) => n.e164 !== e164),
      {
        providerNumberId: `fake_listed_${e164.slice(2)}`,
        e164,
        status,
        capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
        tenDlc: 'none' as const,
        whatsapp: 'none' as const,
      },
    ];
  });
}

/** The owner as a service-level tenant. */
async function tenantOf(org: Org): Promise<Tenant> {
  const me = (await (await get('/api/v1/me', org.cookie)).json()) as Envelope<{
    user: { id: string };
  }>;
  const userId = me.data?.user.id;
  if (!userId) throw new Error('no user');
  return { orgId: org.orgId, userId, role: 'owner' };
}

/**
 * The organization's provider access with an `orderNumber` that waits for `release` before it
 * answers with `answer()`; `entered` resolves once the call is in flight (the hold is committed).
 */
async function gatedAccess(orgId: string, answer: () => Promise<NumberOrderResult>) {
  const base = await withAppDb((db) =>
    withTenant(db, orgId, (tx) => openProviderAccess(tx, env as unknown as Env, orgId)),
  );
  if (base.kind === 'none') throw new Error('no access');
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const access = {
    ...base,
    purchase: {
      ...NO_PURCHASE,
      orderNumber: async () => {
        entered();
        await gate;
        return answer();
      },
    },
  };
  return { access, started, release };
}

/** Buys `quoteId` through the service while a sync completes the order mid provider call. */
async function buyWhileSyncCompletes(
  org: Org,
  quoteId: string,
  answer: () => Promise<NumberOrderResult>,
) {
  const tenant = await tenantOf(org);
  const { access, started, release } = await gatedAccess(org.orgId, answer);
  listAlso('+12025550150', 'active');
  const buying = withAppDb((db) =>
    purchaseNumber(db, env as unknown as Env, tenant, access, { quoteId, idempotencyKey: key() }),
  );
  await started;
  const completed = await withAppDb((db) =>
    syncNumbersAndOrders(db, env as unknown as Env, org.orgId, tenant),
  );
  expect(completed).toBe(1);
  release();
  return buying;
}

describe('search', () => {
  it('lists ten priced numbers for the owner', async () => {
    const { cookie } = await newOrg('np-search');
    const r = await search(cookie);
    expect(r.status).toBe(200);
    const items = ((await r.json()) as Envelope<{ items: Available[] }>).data?.items ?? [];
    expect(items).toHaveLength(10);
    expect(items[0]).toMatchObject({
      e164: '+12025550150',
      upfrontMicros: 1_000_000,
      monthlyMicros: 1_000_000,
    });
  });

  it('403 for an admin and a member, with denied audits', async () => {
    for (const role of ['admin', 'member']) {
      const { cookie, orgId } = await newOrg(`np-role-${role}`);
      await setRole(orgId, role);
      for (const r of [
        await search(cookie),
        await quoteOf(cookie, '+12025550150'),
        await buy(cookie, 'nq_00000000000000000000000000000000', key()),
      ]) {
        expect(r.status).toBe(403);
        expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('forbidden');
      }
      const denied = await withAdminDb((db) =>
        db
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.outcome, 'denied'))),
      );
      expect(denied.map((a) => a.action).sort()).toEqual([
        'numbers.purchase',
        'numbers.quote',
        'numbers.search',
      ]);
    }
  });

  it('400 for a bad area code, region or locality', async () => {
    const { cookie } = await newOrg('np-badinput');
    for (const query of ['?areaCode=12', '?areaCode=155', '?region=Cal', '?locality=a%00b']) {
      expect((await search(cookie, query)).status).toBe(400);
    }
  });

  it('maps a provider RangeError to 400 and a provider failure to 502', async () => {
    const { cookie } = await newOrg('np-provider-err');
    vi.spyOn(FakeProvider.prototype, 'searchAvailableNumbers').mockRejectedValueOnce(
      new RangeError('invalid_search'),
    );
    expect((await search(cookie)).status).toBe(400);
    vi.spyOn(FakeProvider.prototype, 'searchAvailableNumbers').mockRejectedValueOnce(
      new Error('boom'),
    );
    const r = await search(cookie);
    expect(r.status).toBe(502);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('provider_unavailable');
  });

  it('409 voice_not_configured when no provider is set up', async () => {
    const { cookie } = await newOrg('np-none');
    const none = { ...env, APP_ENV: 'production', PROVIDER: 'fake' } as unknown as Env;
    const ctx = createExecutionContext();
    const r = await app.request(
      '/api/v1/numbers/available?areaCode=202',
      { headers: { cookie } },
      none,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('voice_not_configured');
  });
});

describe('quote', () => {
  it('prices the number from the provider and expires within ten minutes', async () => {
    const { cookie } = await newOrg('np-quote');
    const q = await newQuote(cookie);
    expect(q).toMatchObject({
      e164: '+12025550150',
      upfrontMicros: 1_000_000,
      monthlyMicros: 1_000_000,
      totalMicros: 2_000_000,
      currency: 'USD',
    });
    const ttl = Date.parse(q.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('409 quote_invalid when the number is not available; 400 for a malformed number', async () => {
    const { cookie } = await newOrg('np-quote-gone');
    const gone = await quoteOf(cookie, '+12025550199');
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as Envelope<unknown>).error).toEqual({
      code: 'quote_invalid',
      message: 'That number was just taken. Pick another.',
    });
    expect((await quoteOf(cookie, '12025550150')).status).toBe(400);
  });
});

describe('purchase', () => {
  it('buys a number: reserve, capture, assigned, one audit', async () => {
    const { cookie, orgId } = await newOrg('np-buy');
    const before = await available(cookie);
    const q = await newQuote(cookie);
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const body = ((await r.json()) as Envelope<PurchaseJson>).data as PurchaseJson;
    expect(body.order).toMatchObject({
      e164: '+12025550150',
      status: 'completed',
      upfrontMicros: 1_000_000,
      monthlyMicros: 1_000_000,
      failureCode: null,
    });
    expect(body.number?.assignedUse).toBe('calls_and_messages');

    const entries = (await ledgerOf(orgId)).filter((e) => e.refType === 'number_order');
    expect(entries.map((e) => e.kind)).toEqual(['reserve', 'capture']);
    expect(entries[0]?.heldDeltaMicros).toBe(2_000_000);
    expect(entries[1]?.balanceDeltaMicros).toBe(-2_000_000);
    expect(before - (await available(cookie))).toBe(2_000_000);

    const numbers = (await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{
      items: { e164: string; assignedUse: string; status: string }[];
    }>;
    expect(numbers.data?.items.find((n) => n.e164 === '+12025550150')).toMatchObject({
      status: 'active',
      assignedUse: 'calls_and_messages',
    });

    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.organizationId, orgId), eq(auditEvent.action, 'numbers.purchase')),
        ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({
      e164: '+12025550150',
      upfrontMicros: 1_000_000,
      monthlyMicros: 1_000_000,
      status: 'completed',
    });
    const assigns = await assignAudits(orgId);
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({
      outcome: 'allowed',
      entityId: body.number?.id,
      actorUserId: audits[0]?.actorUserId,
      metadata: { assignedUse: 'calls_and_messages', source: 'purchase' },
    });
  });

  it('replays the same key (200, one reserve) and refuses the quote under a new key', async () => {
    const { cookie, orgId } = await newOrg('np-replay');
    const q = await newQuote(cookie);
    const k = key();
    const first = await buy(cookie, q.id, k);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Envelope<PurchaseJson>;
    const again = await buy(cookie, q.id, k);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Envelope<PurchaseJson>).data?.order.id).toBe(
      firstBody.data?.order.id,
    );
    const reserves = (await ledgerOf(orgId)).filter(
      (e) => e.refType === 'number_order' && e.kind === 'reserve',
    );
    expect(reserves).toHaveLength(1);

    const other = await buy(cookie, q.id, key());
    expect(other.status).toBe(409);
    expect(((await other.json()) as Envelope<unknown>).error?.code).toBe('quote_invalid');
  });

  it('places one provider order and one reserve for two concurrent purchases with one key', async () => {
    const { cookie, orgId } = await newOrg('np-concurrent');
    const q = await newQuote(cookie);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const k = key();
    const [a, b] = await Promise.all([buy(cookie, q.id, k), buy(cookie, q.id, k)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(spy).toHaveBeenCalledTimes(1);
    const reserves = (await ledgerOf(orgId)).filter(
      (e) => e.refType === 'number_order' && e.kind === 'reserve',
    );
    expect(reserves).toHaveLength(1);
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders).toHaveLength(1);
  });

  it('releases the hold and leaves no number when the provider order fails', async () => {
    const { cookie, orgId } = await newOrg('np-fail');
    const before = await available(cookie);
    const q = await newQuote(cookie, '+12025550159');
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const body = ((await r.json()) as Envelope<PurchaseJson>).data as PurchaseJson;
    expect(body.order.status).toBe('failed');
    expect(body.order.failureCode).toBe('order_failed');
    expect(body.number).toBeNull();
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'release']);
    expect(await available(cookie)).toBe(before);
    const numbers = (await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{
      items: { e164: string }[];
    }>;
    expect(numbers.data?.items.some((n) => n.e164 === '+12025550159')).toBe(false);
  });

  it('releases the hold on a definite 4xx refusal, with its safe code', async () => {
    const { cookie, orgId } = await newOrg('np-throw-422');
    const before = await available(cookie);
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(
      new TelnyxApiError(422, '10015'),
    );
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const order = ((await r.json()) as Envelope<PurchaseJson>).data?.order;
    expect(order).toMatchObject({ status: 'failed', failureCode: '10015' });
    expect(await available(cookie)).toBe(before);
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'release']);
    expect((await ordersOf(orgId)).map((o) => o.status)).toEqual(['failed']);
  });

  it('keeps the hold and the order pending when a 503 leaves the outcome unknown', async () => {
    const { cookie, orgId } = await newOrg('np-throw-503');
    const before = await available(cookie);
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(
      new TelnyxApiError(503, 'service_unavailable'),
    );
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const body = ((await r.json()) as Envelope<PurchaseJson>).data as PurchaseJson;
    expect(body.order).toMatchObject({ status: 'pending', failureCode: 'unconfirmed' });
    expect(body.number).toBeNull();
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve']);
    expect(await heldOf(cookie)).toBe(2_000_000);
    expect(before - (await available(cookie))).toBe(2_000_000);
  });

  it('keeps the hold for a network error or an unreadable 2xx, never leaking provider text', async () => {
    for (const error of [
      Object.assign(new Error('secret provider detail'), { code: 'ECONNRESET' }),
      new TelnyxApiError(200, 'invalid_response'),
    ]) {
      const { cookie, orgId } = await newOrg('np-throw-unknown');
      const q = await newQuote(cookie);
      vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(error);
      const r = await buy(cookie, q.id, key());
      expect(r.status).toBe(201);
      const text = await r.text();
      expect(text).not.toContain('secret provider detail');
      expect(text).not.toContain('ECONNRESET');
      const order = (JSON.parse(text) as Envelope<PurchaseJson>).data?.order;
      expect(order).toMatchObject({ status: 'pending', failureCode: 'unconfirmed' });
      expect((await ledgerOf(orgId)).filter((e) => e.kind === 'release')).toHaveLength(0);
      expect(await heldOf(cookie)).toBe(2_000_000);
    }
  });

  it('captures an unconfirmed hold exactly once when a sync finds the number active', async () => {
    const { cookie, orgId } = await newOrg('np-orphan');
    const before = await available(cookie);
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(
      new TelnyxApiError(504, 'gateway_timeout'),
    );
    expect((await buy(cookie, q.id, key())).status).toBe(201);
    const [orphan] = await ordersOf(orgId);
    expect(orphan).toMatchObject({ status: 'pending', providerOrderId: null });

    listAlso('+12025550150', 'active');
    for (let i = 0; i < 2; i += 1) {
      expect((await request('/api/v1/numbers/sync', cookie, 'POST', {})).status).toBe(200);
    }
    const entries = (await ledgerOf(orgId)).filter((e) => e.refType === 'number_order');
    expect(entries.map((e) => e.kind)).toEqual(['reserve', 'capture']);
    expect(entries[1]?.balanceDeltaMicros).toBe(-2_000_000);
    expect(await heldOf(cookie)).toBe(0);
    expect(before - (await available(cookie))).toBe(2_000_000);
    expect(await ordersOf(orgId)).toMatchObject([{ status: 'completed', failureCode: null }]);
  });

  it('keeps the hold for an ambiguous 408 or 429, leaving the order unconfirmed', async () => {
    for (const status of [408, 429]) {
      const { cookie, orgId } = await newOrg(`np-throw-${status}`);
      const q = await newQuote(cookie);
      vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(
        new TelnyxApiError(status, 'ambiguous'),
      );
      const r = await buy(cookie, q.id, key());
      expect(r.status).toBe(201);
      const order = ((await r.json()) as Envelope<PurchaseJson>).data?.order;
      expect(order).toMatchObject({ status: 'pending', failureCode: 'unconfirmed' });
      const kinds = (await ledgerOf(orgId))
        .filter((e) => e.refType === 'number_order')
        .map((e) => e.kind);
      expect(kinds).toEqual(['reserve']);
      expect(await heldOf(cookie)).toBe(2_000_000);
    }
  });

  it('refuses to quote a number with an unconfirmed order, without a second order', async () => {
    const { cookie, orgId } = await newOrg('np-open-quote');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockRejectedValueOnce(
      new TelnyxApiError(503, 'service_unavailable'),
    );
    expect((await buy(cookie, q.id, key())).status).toBe(201);
    const quoteSpy = vi.spyOn(FakeProvider.prototype, 'quoteNumber');
    const again = await quoteOf(cookie, '+12025550150');
    expect(again.status).toBe(409);
    expect(((await again.json()) as Envelope<unknown>).error).toEqual({
      code: 'quote_invalid',
      message: 'A purchase for this number is already in progress.',
    });
    expect(quoteSpy).not.toHaveBeenCalled();
    expect(await ordersOf(orgId)).toHaveLength(1);
    const reserves = (await ledgerOf(orgId)).filter(
      (e) => e.refType === 'number_order' && e.kind === 'reserve',
    );
    expect(reserves).toHaveLength(1);
  });

  it('refuses a second quote of a number once it has an order, holding nothing', async () => {
    const { cookie, orgId } = await newOrg('np-open-buy');
    const first = await newQuote(cookie);
    const second = await newQuote(cookie);
    expect((await buy(cookie, first.id, key())).status).toBe(201);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const r = await buy(cookie, second.id, key());
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'quote_invalid',
      message: 'A purchase for this number is already in progress.',
    });
    expect(spy).not.toHaveBeenCalled();
    expect(await ordersOf(orgId)).toHaveLength(1);
    expect(await heldOf(cookie)).toBe(0);
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
  });

  it('holds and orders once when two quotes of one number race under two keys', async () => {
    const { cookie, orgId } = await newOrg('np-open-race');
    const a = await newQuote(cookie);
    const b = await newQuote(cookie);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const [ra, rb] = await Promise.all([buy(cookie, a.id, key()), buy(cookie, b.id, key())]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await ordersOf(orgId)).toHaveLength(1);
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
    expect(await heldOf(cookie)).toBe(0);
  });

  it('captures once and assigns once when a sync completes the order mid provider call', async () => {
    const org = await newOrg('np-sync-race');
    const before = await available(org.cookie);
    const q = await newQuote(org.cookie);
    const outcome = await buyWhileSyncCompletes(org, q.id, async () => ({
      providerOrderId: 'po_raced',
      status: 'completed',
      e164: '+12025550150',
    }));
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    expect(outcome.order).toMatchObject({
      status: 'completed',
      failureCode: null,
      providerOrderId: 'po_raced',
    });
    expect(outcome.number?.assignedUse).toBe('calls_and_messages');
    const kinds = (await ledgerOf(org.orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
    expect(before - (await available(org.cookie))).toBe(2_000_000);
    expect(await ordersOf(org.orgId)).toMatchObject([{ status: 'completed' }]);
    expect(await assignAudits(org.orgId)).toHaveLength(1);
  });

  it('keeps an order completed and charged when a late 4xx follows the capture', async () => {
    const org = await newOrg('np-late-4xx');
    const before = await available(org.cookie);
    const q = await newQuote(org.cookie);
    const outcome = await buyWhileSyncCompletes(org, q.id, async () => {
      throw new TelnyxApiError(422, '10015');
    });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') return;
    // Consistent copy: a completed order with its number, never "failed, nothing was charged".
    expect(outcome.order).toMatchObject({ status: 'completed', failureCode: null });
    expect(outcome.number).not.toBeNull();
    const kinds = (await ledgerOf(org.orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
    expect(before - (await available(org.cookie))).toBe(2_000_000);
    expect(await heldOf(org.cookie)).toBe(0);
    const list = (await (await request('/api/v1/numbers/orders', org.cookie)).json()) as Envelope<{
      items: OrderJson[];
    }>;
    expect(list.data?.items).toMatchObject([{ status: 'completed', failureCode: null }]);
    expect(await assignAudits(org.orgId)).toHaveLength(1);
  });

  it('captures the charge for a pending order and leaves the number unassigned', async () => {
    const { cookie, orgId } = await newOrg('np-pending');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockResolvedValueOnce({
      providerOrderId: 'po_pending',
      status: 'pending',
      e164: '+12025550150',
    });
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const body = ((await r.json()) as Envelope<PurchaseJson>).data as PurchaseJson;
    expect(body.order.status).toBe('pending');
    expect(body.number).toBeNull();
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
  });

  it('keeps a bought order pending when the post-purchase sync fails, and the next sync finishes it', async () => {
    const { cookie, orgId } = await newOrg('np-adopt-fail');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'listNumbers').mockRejectedValueOnce(new Error('down'));
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(201);
    const body = ((await r.json()) as Envelope<PurchaseJson>).data as PurchaseJson;
    expect(body.order).toMatchObject({ status: 'pending', failureCode: null });
    expect(body.number).toBeNull();
    expect(await heldOf(cookie)).toBe(0);

    expect((await request('/api/v1/numbers/sync', cookie, 'POST', {})).status).toBe(200);
    expect((await ordersOf(orgId)).map((o) => o.status)).toEqual(['completed']);
    const numbers = (await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{
      items: { e164: string; assignedUse: string }[];
    }>;
    expect(numbers.data?.items.find((n) => n.e164 === '+12025550150')?.assignedUse).toBe(
      'calls_and_messages',
    );
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
  });

  it('lists a provider-pending number as pending in Numbers right after the purchase', async () => {
    const { cookie, orgId } = await newOrg('np-pending-listed');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockResolvedValueOnce({
      providerOrderId: 'po_pending',
      status: 'pending',
      e164: '+12025550150',
    });
    listAlso('+12025550150', 'pending');
    const r = await buy(cookie, q.id, key());
    expect(((await r.json()) as Envelope<PurchaseJson>).data?.order.status).toBe('pending');
    const numbers = (await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{
      items: { e164: string; assignedUse: string; status: string }[];
    }>;
    expect(numbers.data?.items.find((n) => n.e164 === '+12025550150')).toMatchObject({
      status: 'pending',
      assignedUse: 'unassigned',
    });
    expect((await ordersOf(orgId)).map((o) => o.status)).toEqual(['pending']);
  });

  it('completes a pending order and assigns its number once a sync lists it active', async () => {
    const { cookie, orgId } = await newOrg('np-pending-sync');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockResolvedValueOnce({
      providerOrderId: 'po_pending',
      status: 'pending',
      e164: '+12025550150',
    });
    expect((await buy(cookie, q.id, key())).status).toBe(201);

    const original = FakeProvider.prototype.listNumbers;
    vi.spyOn(FakeProvider.prototype, 'listNumbers').mockImplementation(async function (
      this: FakeProvider,
    ) {
      const base = await original.call(this);
      return [
        ...base,
        {
          providerNumberId: 'fake_pending_arrived',
          e164: '+12025550150',
          status: 'active' as const,
          capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
          tenDlc: 'none' as const,
          whatsapp: 'none' as const,
        },
      ];
    });
    const synced = await request('/api/v1/numbers/sync', cookie, 'POST', {});
    expect(synced.status).toBe(200);
    const items = (
      (await synced.json()) as Envelope<{ items: { e164: string; assignedUse: string }[] }>
    ).data?.items;
    expect(items?.find((n) => n.e164 === '+12025550150')?.assignedUse).toBe('calls_and_messages');
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders.map((o) => o.status)).toEqual(['completed']);
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
    expect((await assignAudits(orgId)).map((a) => a.metadata)).toEqual([
      { assignedUse: 'calls_and_messages', source: 'purchase' },
    ]);
  });

  it('answers 409 for a key already used with another quote, without a second order', async () => {
    const { cookie, orgId } = await newOrg('np-keyreuse');
    const first = await newQuote(cookie, '+12025550150');
    const second = await newQuote(cookie, '+12025550151');
    const k = key();
    expect((await buy(cookie, first.id, k)).status).toBe(201);
    const r = await buy(cookie, second.id, k);
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'This purchase key was already used for another number.',
    });
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders).toHaveLength(1);
  });

  it('places exactly one order when two keys race on one quote', async () => {
    const { cookie, orgId } = await newOrg('np-quote-race');
    const q = await newQuote(cookie);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const [a, b] = await Promise.all([buy(cookie, q.id, key()), buy(cookie, q.id, key())]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(spy).toHaveBeenCalledTimes(1);
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders).toHaveLength(1);
  });

  it('402 when the provider balance is exhausted, with no order row and no provider call', async () => {
    const { cookie, orgId } = await newOrg('np-provider-low');
    expect((await get('/api/v1/wallet', cookie)).status).toBe(200);
    await withAdminDb((db) =>
      db.insert(providerBalanceSnapshot).values({
        organizationId: orgId,
        provider: 'fake',
        status: 'ok',
        balanceMicros: 0,
        currency: 'USD',
        capturedAt: new Date(),
      }),
    );
    const q = await newQuote(cookie);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(402);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('spend_blocked');
    expect(spy).not.toHaveBeenCalled();
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders).toHaveLength(0);
    expect((await ledgerOf(orgId)).filter((e) => e.refType === 'number_order')).toHaveLength(0);
  });

  it('402 spend_blocked with no order row and no provider call under a $1 stop cap', async () => {
    const { cookie, orgId } = await newOrg('np-cap');
    expect((await get('/api/v1/wallet', cookie)).status).toBe(200);
    await withAdminDb((db) =>
      db.update(wallet).set({ stopCapMicros: 1_000_000 }).where(eq(wallet.organizationId, orgId)),
    );
    const q = await newQuote(cookie);
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(402);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('spend_blocked');
    expect(spy).not.toHaveBeenCalled();
    const orders = await withAdminDb((db) =>
      db.select().from(numberOrder).where(eq(numberOrder.organizationId, orgId)),
    );
    expect(orders).toHaveLength(0);
  });

  it('409 quote_invalid for an expired quote, with nothing reserved or ordered', async () => {
    const { cookie, orgId } = await newOrg('np-expired');
    const q = await newQuote(cookie);
    await withAdminDb((db) =>
      db
        .update(numberQuote)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(numberQuote.id, q.id)),
    );
    const spy = vi.spyOn(FakeProvider.prototype, 'orderNumber');
    const r = await buy(cookie, q.id, key());
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'quote_invalid',
      message: 'This price has expired. Search again to see the current price.',
    });
    expect(spy).not.toHaveBeenCalled();
    expect((await ledgerOf(orgId)).filter((e) => e.refType === 'number_order')).toHaveLength(0);
  });

  it('400 for a short idempotency key', async () => {
    const { cookie } = await newOrg('np-shortkey');
    const q = await newQuote(cookie);
    expect((await buy(cookie, q.id, 'short')).status).toBe(400);
  });
});

describe('balance-poll cron step', () => {
  const pollOrg = (orgId: string) =>
    withAppDb((db) => balancePollOrg(db, env as unknown as Env, orgId));

  it('completes a pending order once the listing shows the number active', async () => {
    const { cookie, orgId } = await newOrg('np-cron');
    const q = await newQuote(cookie);
    vi.spyOn(FakeProvider.prototype, 'orderNumber').mockResolvedValueOnce({
      providerOrderId: 'po_pending',
      status: 'pending',
      e164: '+12025550150',
    });
    expect((await buy(cookie, q.id, key())).status).toBe(201);
    expect((await ordersOf(orgId)).map((o) => o.status)).toEqual(['pending']);

    listAlso('+12025550150', 'active');
    await pollOrg(orgId);
    expect((await ordersOf(orgId)).map((o) => o.status)).toEqual(['completed']);
    const numbers = (await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{
      items: { e164: string; assignedUse: string }[];
    }>;
    expect(numbers.data?.items.find((n) => n.e164 === '+12025550150')?.assignedUse).toBe(
      'calls_and_messages',
    );
    const kinds = (await ledgerOf(orgId))
      .filter((e) => e.refType === 'number_order')
      .map((e) => e.kind);
    expect(kinds).toEqual(['reserve', 'capture']);
    const [assign] = await assignAudits(orgId);
    expect(assign).toMatchObject({ actorUserId: null, metadata: { source: 'purchase' } });
  });

  it('skips the numbers sync for an organization without pending orders', async () => {
    const { orgId } = await newOrg('np-cron-idle');
    const spy = vi.spyOn(FakeProvider.prototype, 'listNumbers');
    await pollOrg(orgId);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('tenancy and orders list', () => {
  it('keeps quotes and orders apart between organizations', async () => {
    const a = await newOrg('np-tenant-a');
    const b = await newOrg('np-tenant-b');
    const q = await newQuote(a.cookie);
    const stolen = await buy(b.cookie, q.id, key());
    expect([404, 409]).toContain(stolen.status);
    expect((await ledgerOf(b.orgId)).filter((e) => e.refType === 'number_order')).toHaveLength(0);

    const k = key();
    expect((await buy(a.cookie, q.id, k)).status).toBe(201);
    const listB = (await (await request('/api/v1/numbers/orders', b.cookie)).json()) as Envelope<{
      items: OrderJson[];
    }>;
    expect(listB.data?.items).toEqual([]);
    const listA = (await (await request('/api/v1/numbers/orders', a.cookie)).json()) as Envelope<{
      items: OrderJson[];
    }>;
    expect(listA.data?.items).toHaveLength(1);
    expect(listA.data?.items[0]?.status).toBe('completed');
    // The key is per organization: org B cannot replay org A's order through it.
    const bq = await newQuote(b.cookie);
    const own = await buy(b.cookie, bq.id, k);
    expect(own.status).toBe(201);
  });

  it('lets an admin list orders, and refuses a member', async () => {
    const { cookie, orgId } = await newOrg('np-orders-role');
    await setRole(orgId, 'admin');
    expect((await request('/api/v1/numbers/orders', cookie)).status).toBe(200);
    await setRole(orgId, 'member');
    expect((await request('/api/v1/numbers/orders', cookie)).status).toBe(403);
    const rows = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.organizationId, orgId))
        .orderBy(desc(auditEvent.createdAt))
        .limit(1),
    );
    expect(rows[0]).toMatchObject({ outcome: 'denied' });
  });

  it('feeds completed fake orders into the provider listing', async () => {
    const { cookie, orgId } = await newOrg('np-ordered');
    const q = await newQuote(cookie);
    expect((await buy(cookie, q.id, key())).status).toBe(201);
    const { openProviderAccess } = await import('../src/lib/provider-access');
    const { withAppDb } = await import('./helpers');
    const access = await withAppDb((db) =>
      withTenant(db, orgId, (tx) => openProviderAccess(tx, env as unknown as Env, orgId)),
    );
    if (access.kind === 'none') throw new Error('no access');
    const listed = await access.numbers.listNumbers();
    expect(listed.some((n) => n.e164 === '+12025550150')).toBe(true);
  });
});

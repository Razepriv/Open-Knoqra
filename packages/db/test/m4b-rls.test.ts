import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  ledgerEntry,
  numberOrder,
  numberQuote,
  organization,
  wallet,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

beforeAll(async () => {
  await runMigrations(migrationUrl);
  const now = new Date();
  await admin.db
    .insert(organization)
    .values([
      { id: 'org_a', name: 'Org A', slug: 'org-a', createdAt: now },
      { id: 'org_b', name: 'Org B', slug: 'org-b', createdAt: now },
    ])
    .onConflictDoNothing();
});

beforeEach(async () => {
  await admin.db.execute(
    sql`truncate table number_order, number_quote, wallet, ledger_entry cascade`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

let seq = 0;
const next = () => `${Date.now()}_${++seq}`;

const quote = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  provider: 'fake' as const,
  e164: '+12025550150',
  upfrontMicros: 1_000_000,
  monthlyMicros: 1_000_000,
  currency: 'USD' as const,
  expiresAt: new Date(Date.now() + 600_000),
  createdBy: 'user_1',
  ...over,
});

/** A reservation entry for `orgId`, so an order has something to point at. */
async function seedReservation(orgId: string): Promise<string> {
  const [w] = await admin.db
    .insert(wallet)
    .values({ organizationId: orgId })
    .onConflictDoUpdate({ target: wallet.organizationId, set: { currency: 'USD' } })
    .returning();
  if (!w) throw new Error('no wallet');
  const [entry] = await admin.db
    .insert(ledgerEntry)
    .values({
      organizationId: orgId,
      walletId: w.id,
      kind: 'reserve',
      balanceDeltaMicros: 0,
      heldDeltaMicros: 2_000_000,
      idempotencyKey: `k_${next()}`,
    })
    .returning();
  if (!entry) throw new Error('no entry');
  return entry.id;
}

const orderValues = (
  orgId: string,
  quoteId: string,
  reservationId: string,
  over: Record<string, unknown> = {},
) => ({
  organizationId: orgId,
  quoteId,
  provider: 'fake' as const,
  e164: '+12025550150',
  idempotencyKey: `idem_${next()}`,
  status: 'pending' as const,
  upfrontMicros: 1_000_000,
  monthlyMicros: 1_000_000,
  reservationId,
  createdBy: 'user_1',
  ...over,
});

async function seedOrder(orgId: string) {
  const [q] = await admin.db.insert(numberQuote).values(quote(orgId)).returning();
  if (!q) throw new Error('no quote');
  const reservationId = await seedReservation(orgId);
  const [o] = await admin.db
    .insert(numberOrder)
    .values(orderValues(orgId, q.id, reservationId))
    .returning();
  if (!o) throw new Error('no order');
  return { quote: q, order: o, reservationId };
}

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy on both tables', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('number_quote','number_order')
      order by c.relname`);
    expect(result.rows).toEqual([
      { table: 'number_order', enabled: true, forced: true },
      { table: 'number_quote', enabled: true, forced: true },
    ]);
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining(['number_quote', 'number_order']),
    );
  });
});

describe('tenant isolation', () => {
  it('number_quote', async () => {
    await admin.db.insert(numberQuote).values(quote('org_a'));
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(numberQuote))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(numberQuote))).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) => tx.insert(numberQuote).values(quote('org_a')));
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('number_order', async () => {
    await seedOrder('org_a');
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(numberOrder))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(numberOrder))).toHaveLength(1);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(numberOrder).set({ status: 'completed' }).returning(),
    );
    expect(updated).toHaveLength(0);
  });
});

describe('grants', () => {
  it('number_quote is append-only', async () => {
    await admin.db.insert(numberQuote).values(quote('org_a'));
    const update = withTenant(db, 'org_a', (tx) =>
      tx.update(numberQuote).set({ upfrontMicros: 1 }),
    );
    await expect(update.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) => tx.delete(numberQuote));
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });

  it('number_order may only change its outcome columns and is never deleted', async () => {
    await seedOrder('org_a');
    const done = await withTenant(db, 'org_a', (tx) =>
      tx
        .update(numberOrder)
        .set({ status: 'completed', providerOrderId: 'po_1', failureCode: null })
        .returning(),
    );
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: 'completed', providerOrderId: 'po_1' });
    for (const set of [
      { upfrontMicros: 1 },
      { monthlyMicros: 1 },
      { e164: '+12025550151' },
      { idempotencyKey: 'other_key_1' },
    ]) {
      const attempt = withTenant(db, 'org_a', (tx) => tx.update(numberOrder).set(set));
      await expect(attempt.catch(pgMessage)).resolves.toMatch(/permission denied/);
    }
    const del = withTenant(db, 'org_a', (tx) => tx.delete(numberOrder));
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });
});

describe('constraints', () => {
  it('rejects a negative price and an unknown status', async () => {
    const neg = admin.db.insert(numberQuote).values(quote('org_a', { upfrontMicros: -1 }));
    await expect(neg.catch(pgMessage)).resolves.toMatch(/number_quote_upfront_check/);
    const { order } = await seedOrder('org_a');
    const bad = admin.db.execute(
      sql`update number_order set status = 'weird' where id = ${order.id}`,
    );
    await expect(bad.catch(pgMessage)).resolves.toMatch(/number_order_status_check/);
  });

  it('allows one order per quote and one order per idempotency key', async () => {
    const { quote: q, order, reservationId } = await seedOrder('org_a');
    const sameQuote = admin.db
      .insert(numberOrder)
      .values(orderValues('org_a', q.id, reservationId));
    await expect(sameQuote.catch(pgMessage)).resolves.toMatch(/duplicate key|unique/);
    const [q2] = await admin.db
      .insert(numberQuote)
      .values(quote('org_a', { e164: '+12025550151' }))
      .returning();
    const sameKey = admin.db.insert(numberOrder).values(
      orderValues('org_a', q2?.id as string, reservationId, {
        e164: '+12025550151',
        idempotencyKey: order.idempotencyKey,
      }),
    );
    await expect(sameKey.catch(pgMessage)).resolves.toMatch(
      /number_order_organization_id_idempotency_key_unique/,
    );
  });

  it('allows one open order per number in an organization; a failed one does not block', async () => {
    const { order } = await seedOrder('org_a');
    const secondOrder = async () => {
      const [q] = await admin.db.insert(numberQuote).values(quote('org_a')).returning();
      const reservationId = await seedReservation('org_a');
      return admin.db
        .insert(numberOrder)
        .values(orderValues('org_a', q?.id as string, reservationId))
        .returning();
    };
    await expect(secondOrder().catch(pgMessage)).resolves.toMatch(/number_order_open_e164_unique/);
    await admin.db
      .update(numberOrder)
      .set({ status: 'completed' })
      .where(eq(numberOrder.id, order.id));
    await expect(secondOrder().catch(pgMessage)).resolves.toMatch(/number_order_open_e164_unique/);

    // Another organization may hold the same number.
    await expect(seedOrder('org_b')).resolves.toMatchObject({ order: { status: 'pending' } });

    await admin.db
      .update(numberOrder)
      .set({ status: 'failed' })
      .where(eq(numberOrder.id, order.id));
    const [reopened] = await secondOrder();
    expect(reopened).toMatchObject({ e164: '+12025550150', status: 'pending' });
  });

  it('rejects an order pointing at another tenant quote or reservation', async () => {
    const [qB] = await admin.db.insert(numberQuote).values(quote('org_b')).returning();
    const reservationA = await seedReservation('org_a');
    const crossQuote = admin.db
      .insert(numberOrder)
      .values(orderValues('org_a', qB?.id as string, reservationA));
    await expect(crossQuote.catch(pgMessage)).resolves.toMatch(/number_order_quote_fk/);

    const [qA] = await admin.db.insert(numberQuote).values(quote('org_a')).returning();
    const reservationB = await seedReservation('org_b');
    const crossReservation = admin.db
      .insert(numberOrder)
      .values(orderValues('org_a', qA?.id as string, reservationB));
    await expect(crossReservation.catch(pgMessage)).resolves.toMatch(/number_order_reservation_fk/);
  });
});

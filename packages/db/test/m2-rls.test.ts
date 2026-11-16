import { inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  callEvent,
  callRoute,
  contact,
  createDb,
  ledgerEntry,
  organization,
  providerCredential,
  providerNumberRoute,
  voicemail,
  wallet,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

const M2_TENANT_TABLES = [
  'call',
  'call_event',
  'ledger_entry',
  'provider_credential',
  'voicemail',
  'wallet',
];

const SUITE_ORGS = ['org_a', 'org_b'];

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
    sql`truncate table call, call_event, voicemail, wallet, ledger_entry, provider_credential, contact, call_route, provider_number_route cascade`,
  );
});

// The routing tables are shared with the API and E2E suites (same database): never leave this
// suite's routes behind, or an inbound number would resolve to a test organization.
afterEach(async () => {
  await admin.db.delete(callRoute).where(inArray(callRoute.organizationId, SUITE_ORGS));
  await admin.db
    .delete(providerNumberRoute)
    .where(inArray(providerNumberRoute.organizationId, SUITE_ORGS));
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

let seq = 0;
const next = () => `${Date.now()}_${++seq}`;

const credential = (orgId: string) => ({
  organizationId: orgId,
  provider: 'telnyx' as const,
  apiKeyCiphertext: 'ct',
  apiKeyIv: 'iv',
  dekWrapped: 'dw',
  dekIv: 'di',
  keyFingerprint: 'fp',
  apiKeyLast4: 'abcd',
});
const callValues = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  userId: 'user_1',
  direction: 'outbound' as const,
  state: 'queued' as const,
  fromE164: '+12025550100',
  toE164: '+12025550101',
  provider: 'fake',
  clientState: `cs_${next()}`,
  ...over,
});

async function seedWallet(orgId: string) {
  const [row] = await admin.db.insert(wallet).values({ organizationId: orgId }).returning();
  if (!row) throw new Error('no wallet');
  return row;
}
async function seedCall(orgId: string) {
  const [row] = await admin.db.insert(call).values(callValues(orgId)).returning();
  if (!row) throw new Error('no call');
  return row;
}
const ledger = (orgId: string, walletId: string, over: Record<string, unknown>) => ({
  organizationId: orgId,
  walletId,
  kind: 'credit' as const,
  balanceDeltaMicros: 1_000_000,
  heldDeltaMicros: 0,
  idempotencyKey: `k_${next()}`,
  ...over,
});

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy on every M2 tenant table', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in
        ('call','call_event','ledger_entry','provider_credential','voicemail','wallet')
      order by c.relname`);
    expect(result.rows).toEqual(
      M2_TENANT_TABLES.map((table) => ({ table, enabled: true, forced: true })),
    );
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(M2_TENANT_TABLES));
  });

  it('every M2 tenant table has the organization_id not-empty check', async () => {
    const result = await db.execute<{ table: string }>(sql`
      select c.relname as "table" from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and k.conname like '%organization_id_not_empty'
        and c.relname in ('call','call_event','ledger_entry','provider_credential','voicemail','wallet')
      order by c.relname`);
    expect(result.rows.map((r) => r.table)).toEqual(M2_TENANT_TABLES);
  });
});

describe('tenant isolation', () => {
  it('provider_credential', async () => {
    await admin.db.insert(providerCredential).values(credential('org_a'));
    expect(
      await withTenant(db, 'org_b', (tx) => tx.select().from(providerCredential)),
    ).toHaveLength(0);
    expect(
      await withTenant(db, 'org_a', (tx) => tx.select().from(providerCredential)),
    ).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(providerCredential).values(credential('org_a')),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(providerCredential).set({ apiKeyLast4: 'zzzz' }).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('call', async () => {
    await seedCall('org_a');
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(call))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) => tx.insert(call).values(callValues('org_a')));
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(call).set({ outcomeNote: 'x' }).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('call_event', async () => {
    const c = await seedCall('org_a');
    const values = (orgId: string) => ({
      organizationId: orgId,
      callId: c.id,
      rawEventId: `r_${next()}`,
      signal: 'dialing',
      stateBefore: 'queued',
      stateAfter: 'initiating',
    });
    await admin.db.insert(callEvent).values(values('org_a'));
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(callEvent))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) => tx.insert(callEvent).values(values('org_a')));
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('voicemail', async () => {
    const c = await seedCall('org_a');
    const values = (orgId: string) => ({
      organizationId: orgId,
      callId: c.id,
      fromE164: '+12025550101',
      durationSeconds: 12,
    });
    await admin.db.insert(voicemail).values(values('org_a'));
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(voicemail))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) => tx.insert(voicemail).values(values('org_a')));
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(voicemail).set({ listenedAt: new Date() }).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('wallet', async () => {
    await seedWallet('org_a');
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(wallet))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(wallet).values({ organizationId: 'org_a' }),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(wallet).set({ warnCapMicros: 1 }).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('ledger_entry', async () => {
    const w = await seedWallet('org_a');
    await admin.db.insert(ledgerEntry).values(ledger('org_a', w.id, {}) as never);
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(ledgerEntry))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(ledgerEntry).values(ledger('org_a', w.id, {}) as never),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });
});

describe('append-only grants', () => {
  it('denies UPDATE on ledger_entry and DELETE on call_event', async () => {
    const w = await seedWallet('org_a');
    await admin.db.insert(ledgerEntry).values(ledger('org_a', w.id, {}) as never);
    const upd = withTenant(db, 'org_a', (tx) => tx.update(ledgerEntry).set({ note: 'x' }));
    await expect(upd.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) => tx.delete(callEvent));
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });

  it('voicemail allows only listened_at updates', async () => {
    const c = await seedCall('org_a');
    await admin.db.insert(voicemail).values({
      organizationId: 'org_a',
      callId: c.id,
      fromE164: '+12025550101',
      durationSeconds: 5,
    });
    const bad = withTenant(db, 'org_a', (tx) => tx.update(voicemail).set({ transcript: 'hello' }));
    await expect(bad.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) => tx.delete(voicemail));
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const ok = await withTenant(db, 'org_a', (tx) =>
      tx.update(voicemail).set({ listenedAt: new Date() }).returning(),
    );
    expect(ok).toHaveLength(1);
  });
});

describe('ledger constraints', () => {
  it('rejects a second capture for the same reservation', async () => {
    const w = await seedWallet('org_a');
    const [reserve] = await admin.db
      .insert(ledgerEntry)
      .values(
        ledger('org_a', w.id, {
          kind: 'reserve',
          balanceDeltaMicros: 0,
          heldDeltaMicros: 100_000,
        }) as never,
      )
      .returning();
    if (!reserve) throw new Error('no reserve');
    const capture = () =>
      withTenant(db, 'org_a', (tx) =>
        tx.insert(ledgerEntry).values(
          ledger('org_a', w.id, {
            kind: 'capture',
            balanceDeltaMicros: -10_000,
            heldDeltaMicros: -100_000,
            reservationId: reserve.id,
          }) as never,
        ),
      );
    await capture();
    await expect(capture().catch(pgMessage)).resolves.toMatch(/unique|duplicate/);
  });

  it('rejects a reserve with a negative held delta', async () => {
    const w = await seedWallet('org_a');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(ledgerEntry).values(
        ledger('org_a', w.id, {
          kind: 'reserve',
          balanceDeltaMicros: 0,
          heldDeltaMicros: -1,
        }) as never,
      ),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });

  it('rejects a duplicate idempotency key within an organization', async () => {
    const w = await seedWallet('org_a');
    const row = ledger('org_a', w.id, { idempotencyKey: 'same' }) as never;
    await withTenant(db, 'org_a', (tx) => tx.insert(ledgerEntry).values(row));
    const again = withTenant(db, 'org_a', (tx) => tx.insert(ledgerEntry).values(row));
    await expect(again.catch(pgMessage)).resolves.toMatch(/unique|duplicate/);
  });

  it('rejects a wallet with warn cap above stop cap', async () => {
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(wallet).values({ organizationId: 'org_a', warnCapMicros: 10, stopCapMicros: 5 }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('call foreign keys', () => {
  it('rejects a call whose contact belongs to another organization', async () => {
    const [other] = await admin.db
      .insert(contact)
      .values({ organizationId: 'org_b', displayName: 'Bea', phoneE164: '+12025550102' })
      .returning();
    if (!other) throw new Error('no contact');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(call).values(callValues('org_a', { contactId: other.id }) as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
  });

  it('nulls only contact_id when the contact is deleted', async () => {
    const [c] = await admin.db
      .insert(contact)
      .values({ organizationId: 'org_a', displayName: 'Ana', phoneE164: '+12025550103' })
      .returning();
    if (!c) throw new Error('no contact');
    await admin.db.insert(call).values(callValues('org_a', { contactId: c.id }) as never);
    await admin.db.execute(sql`delete from contact where id = ${c.id}`);
    const after = await admin.db.select().from(call);
    expect(after[0]?.contactId).toBeNull();
    expect(after[0]?.organizationId).toBe('org_a');
  });
});

describe('system routing tables', () => {
  it('are readable by the app role with no tenant set', async () => {
    await admin.db
      .insert(callRoute)
      .values({ clientState: 'cs_x', organizationId: 'org_a', callId: 'cl_x', provider: 'fake' });
    await admin.db
      .insert(providerNumberRoute)
      .values({ provider: 'fake', e164: '+12025550100', organizationId: 'org_a' });
    expect(await db.select().from(callRoute)).toHaveLength(1);
    expect(await db.select().from(providerNumberRoute)).toHaveLength(1);
  });
});

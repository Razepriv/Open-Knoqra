import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  call,
  createDb,
  cronRun,
  ledgerEntry,
  organization,
  phoneNumber,
  providerBalanceSnapshot,
  providerUsageRecord,
  reconciliationReport,
  setupProgress,
  wallet,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

const M4_TENANT_TABLES = [
  'phone_number',
  'provider_balance_snapshot',
  'provider_usage_record',
  'reconciliation_report',
  'setup_progress',
];

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
    sql`truncate table phone_number, provider_balance_snapshot, provider_usage_record, reconciliation_report, setup_progress, call, call_event, voicemail, wallet, ledger_entry cascade`,
  );
});

afterAll(async () => {
  await admin.db.execute(sql`delete from cron_run where name like 'm4test_%'`);
  await app.close();
  await admin.close();
});

let seq = 0;
const next = () => `${Date.now()}_${++seq}`;

const number = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  provider: 'fake' as const,
  providerNumberId: `pnid_${next()}`,
  e164: `+1202555${String(1000 + ++seq).slice(-4)}`,
  status: 'active' as const,
  voice: true,
  sms: false,
  mms: false,
  whatsapp: false,
  tenDlcStatus: 'none' as const,
  whatsappStatus: 'none' as const,
  ...over,
});
const snapshot = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  provider: 'telnyx' as const,
  status: 'ok' as const,
  balanceMicros: 5_000_000 as number | null,
  currency: 'USD' as const,
  capturedAt: new Date(),
  ...over,
});
const usage = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  provider: 'telnyx' as const,
  service: 'voice' as const,
  quantity: 60,
  unit: 'seconds',
  costMicros: 12_000,
  occurredAt: new Date(),
  providerRef: `ref_${next()}`,
  ...over,
});
const report = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  periodDate: '2026-11-01',
  service: 'voice' as const,
  trigger: 'cron' as const,
  status: 'matched' as const,
  capturedMicros: 100,
  providerMicros: 100,
  ledgerMicros: 100,
  driftMicros: 0,
  ...over,
});

async function seedCall(orgId: string) {
  const [row] = await admin.db
    .insert(call)
    .values({
      organizationId: orgId,
      userId: 'user_1',
      direction: 'outbound',
      state: 'queued',
      fromE164: '+12025550100',
      toE164: '+12025550101',
      provider: 'fake',
      clientState: `cs_${next()}`,
    })
    .returning();
  if (!row) throw new Error('no call');
  return row;
}

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy on every M4 tenant table', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in
        ('phone_number','provider_balance_snapshot','provider_usage_record','reconciliation_report','setup_progress')
      order by c.relname`);
    expect(result.rows).toEqual(
      M4_TENANT_TABLES.map((table) => ({ table, enabled: true, forced: true })),
    );
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(M4_TENANT_TABLES));
  });
});

describe('tenant isolation', () => {
  it('phone_number', async () => {
    await admin.db.insert(phoneNumber).values(number('org_a'));
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(phoneNumber))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(phoneNumber))).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) => tx.insert(phoneNumber).values(number('org_a')));
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(phoneNumber).set({ whatsapp: true }).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('provider_balance_snapshot', async () => {
    await admin.db.insert(providerBalanceSnapshot).values(snapshot('org_a'));
    expect(
      await withTenant(db, 'org_b', (tx) => tx.select().from(providerBalanceSnapshot)),
    ).toHaveLength(0);
    expect(
      await withTenant(db, 'org_a', (tx) => tx.select().from(providerBalanceSnapshot)),
    ).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(providerBalanceSnapshot).values(snapshot('org_a')),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('provider_usage_record', async () => {
    await admin.db.insert(providerUsageRecord).values(usage('org_a'));
    expect(
      await withTenant(db, 'org_b', (tx) => tx.select().from(providerUsageRecord)),
    ).toHaveLength(0);
    expect(
      await withTenant(db, 'org_a', (tx) => tx.select().from(providerUsageRecord)),
    ).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(providerUsageRecord).values(usage('org_a')),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('reconciliation_report', async () => {
    await admin.db.insert(reconciliationReport).values(report('org_a'));
    expect(
      await withTenant(db, 'org_b', (tx) => tx.select().from(reconciliationReport)),
    ).toHaveLength(0);
    expect(
      await withTenant(db, 'org_a', (tx) => tx.select().from(reconciliationReport)),
    ).toHaveLength(1);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(reconciliationReport).values(report('org_a')),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('setup_progress', async () => {
    await admin.db.insert(setupProgress).values({ organizationId: 'org_a', userId: 'user_1' });
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(setupProgress))).toHaveLength(0);
    const insert = withTenant(db, 'org_b', (tx) =>
      tx.insert(setupProgress).values({ organizationId: 'org_a', userId: 'user_2' }),
    );
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx.update(setupProgress).set({ lastStep: 'audio' }).returning(),
    );
    expect(updated).toHaveLength(0);
  });
});

describe('append-only grants', () => {
  it('denies UPDATE and DELETE on snapshots, usage records and reports', async () => {
    await admin.db.insert(providerBalanceSnapshot).values(snapshot('org_a'));
    await admin.db.insert(providerUsageRecord).values(usage('org_a'));
    await admin.db.insert(reconciliationReport).values(report('org_a'));
    const attempts = [
      () =>
        withTenant(db, 'org_a', (tx) =>
          tx.update(providerBalanceSnapshot).set({ balanceMicros: 1 }),
        ),
      () => withTenant(db, 'org_a', (tx) => tx.delete(providerBalanceSnapshot)),
      () => withTenant(db, 'org_a', (tx) => tx.update(providerUsageRecord).set({ costMicros: 1 })),
      () => withTenant(db, 'org_a', (tx) => tx.delete(providerUsageRecord)),
      () =>
        withTenant(db, 'org_a', (tx) => tx.update(reconciliationReport).set({ driftMicros: 1 })),
      () => withTenant(db, 'org_a', (tx) => tx.delete(reconciliationReport)),
    ];
    for (const attempt of attempts) {
      await expect(attempt().catch(pgMessage)).resolves.toMatch(/permission denied/);
    }
  });
});

describe('constraints', () => {
  it('rejects an ok snapshot without a balance and a failed one with a balance', async () => {
    const ok = admin.db
      .insert(providerBalanceSnapshot)
      .values(snapshot('org_a', { balanceMicros: null }));
    await expect(ok.catch(pgMessage)).resolves.toMatch(/provider_balance_snapshot_balance_check/);
    const bad = admin.db
      .insert(providerBalanceSnapshot)
      .values(snapshot('org_a', { status: 'unavailable' }));
    await expect(bad.catch(pgMessage)).resolves.toMatch(/provider_balance_snapshot_balance_check/);
    await admin.db
      .insert(providerBalanceSnapshot)
      .values(snapshot('org_a', { status: 'auth_failed', balanceMicros: null }));
  });

  it('rejects an adjusted report without an adjustment entry', async () => {
    const attempt = admin.db
      .insert(reconciliationReport)
      .values(report('org_a', { status: 'adjusted' }));
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/reconciliation_report_adjusted_check/);
  });

  it('accepts an adjusted report with a real ledger entry, rejects another tenant', async () => {
    const [w] = await admin.db.insert(wallet).values({ organizationId: 'org_a' }).returning();
    if (!w) throw new Error('no wallet');
    const [entry] = await admin.db
      .insert(ledgerEntry)
      .values({
        organizationId: 'org_a',
        walletId: w.id,
        kind: 'adjust',
        balanceDeltaMicros: -5,
        heldDeltaMicros: 0,
        idempotencyKey: `k_${next()}`,
      })
      .returning();
    if (!entry) throw new Error('no entry');
    await admin.db
      .insert(reconciliationReport)
      .values(report('org_a', { status: 'adjusted', adjustEntryId: entry.id }));
    const cross = admin.db
      .insert(reconciliationReport)
      .values(report('org_b', { status: 'adjusted', adjustEntryId: entry.id }));
    await expect(cross.catch(pgMessage)).resolves.toMatch(/reconciliation_report_adjust_entry_fk/);
  });

  it('rejects a duplicate (org, provider, provider_ref) usage record', async () => {
    const values = usage('org_a', { providerRef: 'ref_dup' });
    await admin.db.insert(providerUsageRecord).values(values);
    const dup = admin.db.insert(providerUsageRecord).values(values);
    await expect(dup.catch(pgMessage)).resolves.toMatch(/duplicate key|unique/);
    await admin.db.insert(providerUsageRecord).values({ ...values, organizationId: 'org_b' });
  });

  it('rejects a duplicate e164 per organization but allows it across organizations', async () => {
    await admin.db.insert(phoneNumber).values(number('org_a', { e164: '+12025550177' }));
    const dup = admin.db.insert(phoneNumber).values(number('org_a', { e164: '+12025550177' }));
    await expect(dup.catch(pgMessage)).resolves.toMatch(/duplicate key|unique/);
    await admin.db.insert(phoneNumber).values(number('org_b', { e164: '+12025550177' }));
  });

  it('rejects a setup_progress test_call_id pointing at another tenant call', async () => {
    const callB = await seedCall('org_b');
    const attempt = admin.db
      .insert(setupProgress)
      .values({ organizationId: 'org_a', userId: 'user_1', testCallId: callB.id });
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/setup_progress_test_call_fk/);
  });

  it('nulls setup_progress.test_call_id when the call is deleted, keeping the org id', async () => {
    const callA = await seedCall('org_a');
    await admin.db
      .insert(setupProgress)
      .values({ organizationId: 'org_a', userId: 'user_1', testCallId: callA.id });
    await admin.db.execute(sql`delete from call where id = ${callA.id}`);
    const rows = await admin.db.select().from(setupProgress);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.testCallId).toBeNull();
    expect(rows[0]?.organizationId).toBe('org_a');
  });
});

describe('cron_run', () => {
  it('is readable and writable by the app role with no tenant set', async () => {
    const name = `m4test_${next()}`;
    const now = new Date();
    await db.insert(cronRun).values({ name, lastStartedAt: now, lastStatus: 'running' });
    await db
      .update(cronRun)
      .set({ lastStatus: 'ok', lastFinishedAt: now, lastDurationMs: 3 })
      .where(sql`${cronRun.name} = ${name}`);
    const rows = await db.select().from(cronRun).where(sql`${cronRun.name} = ${name}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastStatus).toBe('ok');
  });
});

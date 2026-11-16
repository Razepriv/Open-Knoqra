import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  auditEvent,
  call,
  cronRun,
  ledgerEntry,
  member,
  organization,
  providerUsageRecord,
  reconciliationReport,
  type Tx,
  withTenant,
} from '@knoqra/db';
import type { ProviderUsage } from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type CronJob, runReconcile } from '../src/cron/jobs';
import { handleScheduled } from '../src/cron/run';
import type { Env } from '../src/env';
import type { ProviderAccess } from '../src/lib/provider-access';
import { ensureWallet, reserve, settleReservation } from '../src/services/ledger';
import { reconcileOrgDay } from '../src/services/reconcile';
import { get, NO_PURCHASE, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Org = { cookie: string; orgId: string; userId: string };
type Report = { id: string; status: string; driftMicros: number; adjustEntryId: string | null };
type ReportPage = { items: Report[]; nextCursor: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const TODAY = day(0);

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  return { cookie, orgId, userId };
}

const inTenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withAppDb((db) => withTenant(db, orgId, fn));

/** A captured call of `costMicros` today, as the pipeline books it. */
async function captureCall(orgId: string, costMicros: number): Promise<void> {
  const id = crypto.randomUUID();
  await inTenant(orgId, async (tx) => {
    await ensureWallet(tx, orgId, { starterCredit: true });
    const held = await reserve(tx, {
      orgId,
      amountMicros: 100_000,
      idempotencyKey: `rc-hold-${id}`,
      refType: 'call',
      refId: id,
      actorUserId: null,
    });
    if ('refused' in held) throw new Error('reserve refused');
    await settleReservation(tx, {
      orgId,
      reservationId: held.entry.id,
      costMicros,
      idempotencyKey: `rc-settle-${id}`,
      refType: 'call',
      refId: id,
    });
  });
}

const accessWith = (usage: () => Promise<ProviderUsage[]>): ProviderAccess => ({
  kind: 'fake',
  numbers: { listNumbers: async () => [] },
  purchase: NO_PURCHASE,
  connectionId: null,
  balance: { fetchBalance: async () => ({ balanceMicros: 1, currency: 'USD' }) },
  usage: { fetchUsage: usage },
});

const callUsage = (cost: number): ProviderUsage => ({
  service: 'voice',
  quantity: 61,
  unit: 'second',
  costMicros: cost,
  occurredAt: new Date().toISOString(),
  providerRef: `fake_call_${crypto.randomUUID()}`,
});

const seedDrift = (orgId: string, date: string, costMicros: number) =>
  withAdminDb((db) =>
    db.insert(providerUsageRecord).values({
      organizationId: orgId,
      provider: 'fake',
      service: 'voice',
      costMicros,
      occurredAt: new Date(`${date}T12:00:00.000Z`),
      providerRef: `fake_drift_${crypto.randomUUID()}`,
    }),
  );

const reconcile = (
  orgId: string,
  access?: ProviderAccess,
  date = TODAY,
  actorUserId: string | null = null,
) =>
  withAppDb((db) =>
    reconcileOrgDay(db, env as Env, {
      orgId,
      date,
      trigger: 'manual',
      actorUserId,
      access,
    }),
  );

const adjustsOf = (orgId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(ledgerEntry)
      .where(and(eq(ledgerEntry.organizationId, orgId), eq(ledgerEntry.kind, 'adjust'))),
  );

const reportsOf = (orgId: string) =>
  withAdminDb((db) =>
    db.select().from(reconciliationReport).where(eq(reconciliationReport.organizationId, orgId)),
  );

describe('reconcileOrgDay', () => {
  it('matches a billed fake call (61 s, 20,000) with no adjust', async () => {
    const o = await newOrg('rc-match');
    const callId = crypto.randomUUID();
    await withAdminDb((db) =>
      db.insert(call).values({
        id: `cl_${callId.replaceAll('-', '')}`,
        organizationId: o.orgId,
        userId: o.userId,
        direction: 'outbound',
        state: 'completed',
        fromE164: '+12025550101',
        toE164: '+12025550102',
        provider: 'fake',
        clientState: `cs-${callId}`,
        billableSeconds: 61,
        endedAt: new Date(),
      }),
    );
    await captureCall(o.orgId, 20_000);
    const report = await reconcile(o.orgId);
    expect(report).toMatchObject({
      status: 'matched',
      driftMicros: 0,
      providerMicros: 20_000,
      capturedMicros: 20_000,
      adjustEntryId: null,
    });
    expect(await adjustsOf(o.orgId)).toHaveLength(0);
  });

  it('adjusts seeded drift once, audits it and stays matched on a re-run', async () => {
    const o = await newOrg('rc-drift');
    await captureCall(o.orgId, 20_000);
    await seedDrift(o.orgId, TODAY, 30_000);
    const usage = [callUsage(20_000)];
    const access = accessWith(async () => usage);
    const first = await reconcile(o.orgId, access, TODAY, o.userId);
    expect(first).toMatchObject({
      status: 'adjusted',
      driftMicros: 30_000,
      providerMicros: 50_000,
      ledgerMicros: 20_000,
    });
    const adjusts = await adjustsOf(o.orgId);
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0]).toMatchObject({ balanceDeltaMicros: -30_000, heldDeltaMicros: 0 });
    expect(first?.adjustEntryId).toBe(adjusts[0]?.id);
    const audits = await inTenant(o.orgId, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'ledger.reconcile')),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(o.userId);
    expect(audits[0]?.metadata).toEqual({
      date: TODAY,
      service: 'voice',
      status: 'adjusted',
      driftMicros: 30_000,
    });
    const again = await reconcile(o.orgId, access);
    expect(again).toMatchObject({ status: 'matched', driftMicros: 0 });
    expect(await adjustsOf(o.orgId)).toHaveLength(1);
    expect(await reportsOf(o.orgId)).toHaveLength(2);
  });

  it('two concurrent runs over the same drift book exactly one adjust', async () => {
    const o = await newOrg('rc-concurrent');
    await captureCall(o.orgId, 20_000);
    await seedDrift(o.orgId, TODAY, 30_000);
    const usage = [callUsage(20_000)];
    const access = accessWith(async () => usage);
    const results = await Promise.all([reconcile(o.orgId, access), reconcile(o.orgId, access)]);
    expect(await adjustsOf(o.orgId)).toHaveLength(1);
    expect(results.map((r) => r?.status).sort()).toEqual(['adjusted', 'matched']);
  });

  it('reports provider_unavailable when the provider throws, without adjusting', async () => {
    const o = await newOrg('rc-down');
    await captureCall(o.orgId, 20_000);
    const report = await reconcile(
      o.orgId,
      accessWith(async () => {
        throw new Error('provider down');
      }),
    );
    expect(report).toMatchObject({
      status: 'provider_unavailable',
      providerMicros: null,
      driftMicros: 0,
    });
    expect(await adjustsOf(o.orgId)).toHaveLength(0);
  });

  it('sends a drift of 60,000,000 to needs_review without adjusting', async () => {
    const o = await newOrg('rc-review');
    await seedDrift(o.orgId, TODAY, 60_000_000);
    const report = await reconcile(
      o.orgId,
      accessWith(async () => []),
    );
    expect(report).toMatchObject({ status: 'needs_review', driftMicros: 60_000_000 });
    expect(await adjustsOf(o.orgId)).toHaveLength(0);
  });

  it('returns null and writes no report without a provider', async () => {
    const o = await newOrg('rc-none');
    expect(await reconcile(o.orgId, { kind: 'none' })).toBeNull();
    expect(await reportsOf(o.orgId)).toHaveLength(0);
  });
});

describe('ledger-reconcile cron', () => {
  it('reconciles yesterday for the seeded organizations and records an ok run', async () => {
    // Ids sort after every real organization, so the walk stays on these two.
    const prefix = `zzzz_rc_${crypto.randomUUID().replaceAll('-', '')}`;
    const ids = [`${prefix}_a`, `${prefix}_b`];
    await withAdminDb((db) =>
      db
        .insert(organization)
        .values(ids.map((id) => ({ id, name: id, slug: id, createdAt: new Date() }))),
    );
    try {
      for (const id of ids)
        await inTenant(id, (tx) => ensureWallet(tx, id, { starterCredit: true }));
      const yesterday = day(-1);
      const drifts = [30_000, 40_000];
      await Promise.all(ids.map((id, i) => seedDrift(id, yesterday, drifts[i] ?? 0)));
      const job: CronJob = {
        name: 'ledger-reconcile',
        cron: '15 3 * * *',
        maxIntervalMinutes: 1500,
        run: (e) => runReconcile(e, { afterId: prefix }),
      };
      await handleScheduled(
        { cron: '15 3 * * *' } as unknown as ScheduledController,
        env as Env,
        createExecutionContext(),
        [job],
      );
      for (const [i, id] of ids.entries()) {
        const reports = await reportsOf(id);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          periodDate: yesterday,
          trigger: 'cron',
          status: 'adjusted',
          driftMicros: drifts[i],
        });
      }
      const [run] = await withAdminDb((db) =>
        db.select().from(cronRun).where(eq(cronRun.name, 'ledger-reconcile')),
      );
      expect(run?.lastStatus).toBe('ok');
    } finally {
      await withAdminDb(async (db) => {
        await db
          .delete(providerUsageRecord)
          .where(inArray(providerUsageRecord.organizationId, ids));
        await db.delete(organization).where(inArray(organization.id, ids));
      });
    }
  });
});

describe('reconciliation routes', () => {
  it('pages newest first and hides other organizations', async () => {
    const a = await newOrg('rc-route-a');
    const b = await newOrg('rc-route-b');
    for (const date of [day(-2), day(-1)]) {
      const r = await post('/api/v1/usage/reconciliations', a.cookie, { date });
      expect(r.status).toBe(201);
    }
    const page = (await (
      await get('/api/v1/usage/reconciliations?limit=1', a.cookie)
    ).json()) as Envelope<ReportPage>;
    expect(page.data?.items).toHaveLength(1);
    expect(page.data?.nextCursor).not.toBeNull();
    const next = (await (
      await get(`/api/v1/usage/reconciliations?limit=1&cursor=${page.data?.nextCursor}`, a.cookie)
    ).json()) as Envelope<ReportPage>;
    expect(next.data?.items).toHaveLength(1);
    expect(next.data?.items[0]?.id).not.toBe(page.data?.items[0]?.id);
    const other = (await (
      await get('/api/v1/usage/reconciliations', b.cookie)
    ).json()) as Envelope<ReportPage>;
    expect(other.data?.items).toEqual([]);
  });

  it('refuses a plain member with 403', async () => {
    const o = await newOrg('rc-route-member');
    await withAdminDb((db) =>
      db
        .update(member)
        .set({ role: 'member' })
        .where(and(eq(member.organizationId, o.orgId), eq(member.userId, o.userId))),
    );
    const r = await post('/api/v1/usage/reconciliations', o.cookie, { date: TODAY });
    expect(r.status).toBe(403);
    expect(await reportsOf(o.orgId)).toHaveLength(0);
  });

  it('rejects a future date, an old date and a non-calendar date with 400', async () => {
    const o = await newOrg('rc-route-dates');
    for (const date of [day(1), day(-91), '2026-02-30']) {
      const r = await post('/api/v1/usage/reconciliations', o.cookie, { date });
      expect(r.status).toBe(400);
    }
  });
});

describe('POST /api/v1/dev/fake-provider/usage', () => {
  it('seeds one fake voice usage record at noon of the date', async () => {
    const o = await newOrg('rc-dev-usage');
    const r = await post('/api/v1/dev/fake-provider/usage', o.cookie, {
      date: TODAY,
      costMicros: 30_000,
    });
    expect(r.status).toBe(202);
    const rows = await withAdminDb((db) =>
      db.select().from(providerUsageRecord).where(eq(providerUsageRecord.organizationId, o.orgId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'fake', service: 'voice', costMicros: 30_000 });
    expect(rows[0]?.occurredAt.toISOString()).toBe(`${TODAY}T12:00:00.000Z`);
    expect(rows[0]?.providerRef).toMatch(/^fake_drift_/);
    const bad = await post('/api/v1/dev/fake-provider/usage', o.cookie, {
      date: TODAY,
      costMicros: 0,
    });
    expect(bad.status).toBe(400);
  });
});

import { planReconciliation } from '@knoqra/core';
import {
  call,
  type Database,
  ledgerEntry,
  providerUsageRecord,
  type ReconciliationReportRow,
  reconciliationReport,
  withTenant,
} from '@knoqra/db';
import type { ProviderUsage } from '@knoqra/providers';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import type { ReconciliationJson } from '../lib/m4-schemas';
import { callBillingOf } from '../lib/pricing';
import { openProviderAccess, type ProviderAccess } from '../lib/provider-access';
import { publish } from '../lib/realtime';
import { insertUsageAudit } from '../lib/usage-audit';
import { adjust, ensureWallet, type WalletSummary, walletSummary } from './ledger';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReconcileInput {
  orgId: string;
  /** A UTC day, `YYYY-MM-DD`. */
  date: string;
  trigger: 'cron' | 'manual';
  actorUserId: string | null;
  access?: ProviderAccess;
}

export function toReconciliationJson(row: ReconciliationReportRow): ReconciliationJson {
  return {
    id: row.id,
    date: row.periodDate,
    service: row.service,
    trigger: row.trigger,
    status: row.status,
    capturedMicros: row.capturedMicros,
    providerMicros: row.providerMicros,
    ledgerMicros: row.ledgerMicros,
    driftMicros: row.driftMicros,
    adjustEntryId: row.adjustEntryId,
    createdAt: row.createdAt.toISOString(),
  };
}

const toMicros = (value: unknown): number => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new RangeError('sum is not a safe integer');
  return n;
};

async function fetchDay(
  access: Exclude<ProviderAccess, { kind: 'none' }>,
  from: Date,
  to: Date,
): Promise<ProviderUsage[] | null> {
  try {
    return await access.usage.fetchUsage({ from: from.toISOString(), to: to.toISOString() });
  } catch (error) {
    logger.warn('reconcile.fetch_failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * Reconciles one UTC day of voice usage: provider-reported cost against the estimated provider cost
 * of the calls the ledger charged that day. A difference is passed on at cost (an adjustment).
 * Returns null (and writes nothing) when the organization has no provider. Serialized per
 * (organization, day) by an advisory lock, so concurrent runs adjust at most once.
 */
export async function reconcileOrgDay(
  db: Database,
  env: Env,
  input: ReconcileInput,
): Promise<ReconciliationJson | null> {
  const { orgId, date } = input;
  const access =
    input.access ?? (await withTenant(db, orgId, (tx) => openProviderAccess(tx, env, orgId)));
  if (access.kind === 'none') return null;
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + DAY_MS);
  // Outside any transaction: the provider can be slow.
  const fetched = await fetchDay(access, from, to);

  const result = await withTenant(db, orgId, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`reconcile:${orgId}:${date}`}, 0))`,
    );
    const voice = (fetched ?? []).filter((u) => u.service === 'voice');
    if (voice.length > 0) {
      await tx
        .insert(providerUsageRecord)
        .values(
          voice.map((u) => ({
            organizationId: orgId,
            provider: access.kind,
            service: u.service,
            quantity: u.quantity,
            unit: u.unit,
            costMicros: u.costMicros,
            occurredAt: new Date(u.occurredAt),
            providerRef: u.providerRef,
          })),
        )
        .onConflictDoNothing();
    }
    const [usageSum] = await tx
      .select({ sum: sql<string>`coalesce(sum(${providerUsageRecord.costMicros}), 0)::text` })
      .from(providerUsageRecord)
      .where(
        and(
          eq(providerUsageRecord.organizationId, orgId),
          eq(providerUsageRecord.service, 'voice'),
          gte(providerUsageRecord.occurredAt, from),
          lt(providerUsageRecord.occurredAt, to),
        ),
      );
    // The provider's estimated cost of the day's charged calls: a call priced per destination
    // carries its estimate (the price adds KNOQRA's markup, which is not the provider's). A call
    // without one was charged at cost, so its capture is the estimate.
    const [captured] = await tx
      .select({
        sum: sql<string>`coalesce(sum(coalesce(${call.providerCostMicros}, -${ledgerEntry.balanceDeltaMicros})), 0)::text`,
      })
      .from(ledgerEntry)
      .leftJoin(
        call,
        and(eq(call.organizationId, ledgerEntry.organizationId), eq(call.id, ledgerEntry.refId)),
      )
      .where(
        and(
          eq(ledgerEntry.organizationId, orgId),
          eq(ledgerEntry.kind, 'capture'),
          eq(ledgerEntry.refType, 'call'),
          gte(ledgerEntry.createdAt, from),
          lt(ledgerEntry.createdAt, to),
        ),
      );
    const refId = `${date}:voice`;
    const [adjusted] = await tx
      .select({ sum: sql<string>`coalesce(sum(${ledgerEntry.balanceDeltaMicros}), 0)::text` })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.organizationId, orgId),
          eq(ledgerEntry.kind, 'adjust'),
          eq(ledgerEntry.refType, 'reconciliation'),
          eq(ledgerEntry.refId, refId),
        ),
      );
    const providerMicros = fetched === null ? null : toMicros(usageSum?.sum);
    const capturedMicros = toMicros(captured?.sum);
    const plan = planReconciliation({
      capturedMicros,
      adjustedMicros: toMicros(adjusted?.sum),
      providerMicros,
    });
    let adjustEntryId: string | null = null;
    let summary: WalletSummary | null = null;
    if (plan.status === 'adjusted') {
      const walletRow = await ensureWallet(tx, orgId, { starterCredit: false });
      const { entry } = await adjust(tx, {
        orgId,
        balanceDeltaMicros: plan.adjustBalanceDeltaMicros,
        note: `Reconciliation ${date} (voice)`,
        idempotencyKey: `reconcile:${date}:voice:${providerMicros}:${plan.ledgerMicros}:${toMicros(adjusted?.sum)}`,
        refType: 'reconciliation',
        refId,
        actorUserId: input.actorUserId,
      });
      adjustEntryId = entry.id;
      summary = await walletSummary(tx, walletRow, new Date(), callBillingOf(env));
    }
    const [report] = await tx
      .insert(reconciliationReport)
      .values({
        organizationId: orgId,
        periodDate: date,
        service: 'voice',
        trigger: input.trigger,
        status: plan.status,
        capturedMicros,
        providerMicros,
        ledgerMicros: plan.ledgerMicros,
        driftMicros: plan.driftMicros,
        adjustEntryId,
        actorUserId: input.actorUserId,
      })
      .returning();
    if (!report) throw new Error('reconciliation insert returned no row');
    await insertUsageAudit(tx, null, {
      action: 'ledger.reconcile',
      outcome: 'allowed',
      entityType: 'reconciliation',
      entityId: report.id,
      orgId,
      actorUserId: input.trigger === 'manual' ? input.actorUserId : null,
      metadata: { date, service: 'voice', status: plan.status, driftMicros: plan.driftMicros },
    });
    return { json: toReconciliationJson(report), summary };
  });
  if (result.summary) {
    await publish(env, orgId, { type: 'wallet.updated', data: result.summary });
  }
  return result.json;
}

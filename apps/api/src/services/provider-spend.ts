import { evaluateProviderBalance, type SpendDecision } from '@knoqra/core';
import { providerBalanceSnapshot, type Tx } from '@knoqra/db';
import { desc } from 'drizzle-orm';
import type { ProviderSnapshotJson } from '../lib/m4-schemas';

/** The newest snapshot of the tenant (RLS-scoped `tx`), or null. */
export async function latestSnapshot(tx: Tx) {
  const [row] = await tx
    .select()
    .from(providerBalanceSnapshot)
    .orderBy(desc(providerBalanceSnapshot.capturedAt))
    .limit(1);
  return row ?? null;
}

export function snapshotJson(
  row: Awaited<ReturnType<typeof latestSnapshot>>,
): ProviderSnapshotJson | null {
  return row
    ? {
        status: row.status,
        balanceMicros: row.balanceMicros,
        capturedAt: row.capturedAt.toISOString(),
      }
    : null;
}

/** The newest snapshot decides; a non-ok, missing or stale snapshot has no effect. */
export async function providerSpendDecision(tx: Tx, now: Date): Promise<SpendDecision> {
  const row = await latestSnapshot(tx);
  return evaluateProviderBalance({
    balanceMicros: row?.status === 'ok' ? row.balanceMicros : null,
    capturedAt: row?.capturedAt ?? null,
    now,
  });
}

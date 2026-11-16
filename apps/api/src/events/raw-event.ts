import { type Database, type ProviderEventRaw, providerEventRaw, type Tx } from '@knoqra/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

/** Statuses a queue delivery may still work on; anything else is final and a redelivery is a no-op. */
const OPEN_STATUSES = ['pending', 'parked'] as const;

/**
 * Counts this delivery as an attempt and returns the row, or undefined when the row is missing or
 * already final. One statement, so the status check and the increment cannot interleave.
 */
export async function claimRawEvent(
  db: Database,
  rawEventId: string,
): Promise<ProviderEventRaw | undefined> {
  const [row] = await db
    .update(providerEventRaw)
    .set({ attempts: sql`${providerEventRaw.attempts} + 1` })
    .where(
      and(eq(providerEventRaw.id, rawEventId), inArray(providerEventRaw.status, OPEN_STATUSES)),
    )
    .returning();
  return row;
}

/** Inside the tenant transaction that applied the event: commits with the call changes. */
export async function markProcessed(tx: Tx, rawEventId: string): Promise<void> {
  await tx
    .update(providerEventRaw)
    .set({ status: 'processed', processedAt: new Date(), parkReason: null })
    .where(eq(providerEventRaw.id, rawEventId));
}

/** No tenant is known for these outcomes; the system table has no row-level security. */
export async function markIgnored(db: Database, rawEventId: string): Promise<void> {
  await db
    .update(providerEventRaw)
    .set({ status: 'ignored', processedAt: new Date() })
    .where(eq(providerEventRaw.id, rawEventId));
}

export async function markParked(db: Database, rawEventId: string, reason: string): Promise<void> {
  await db
    .update(providerEventRaw)
    .set({ status: 'parked', parkReason: reason })
    .where(eq(providerEventRaw.id, rawEventId));
}

/** Never overwrites a row that was processed or ignored after all. */
export async function markDeadLettered(db: Database, rawEventId: string): Promise<void> {
  await db
    .update(providerEventRaw)
    .set({ status: 'dead_lettered' })
    .where(
      and(eq(providerEventRaw.id, rawEventId), inArray(providerEventRaw.status, OPEN_STATUSES)),
    );
}

/** The row's status, or undefined when there is no such row (for skip diagnostics). */
export async function rawEventStatus(
  db: Database,
  rawEventId: string,
): Promise<ProviderEventRaw['status'] | undefined> {
  const [row] = await db
    .select({ status: providerEventRaw.status })
    .from(providerEventRaw)
    .where(eq(providerEventRaw.id, rawEventId))
    .limit(1);
  return row?.status;
}

import { type PhoneNumberRow, phoneNumber, providerCredential, type Tx } from '@knoqra/db';
import type { NumbersProvider, ProviderNumber } from '@knoqra/providers';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { claimNumber } from '../connectors/store';
import type { Tenant } from '../lib/context';
import { refreshTelnyxSenders } from '../messaging/senders';

export type AssignedUse = PhoneNumberRow['assignedUse'];
export type NumberProviderKind = PhoneNumberRow['provider'];

/** Serializes number writes for one organization until the transaction ends. */
export async function lockNumbers(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`numbers:${orgId}`}, 0))`);
}

export interface SyncResult {
  added: number;
  updated: number;
  deactivated: number;
}

const CALLS_USES: readonly AssignedUse[] = ['calls', 'calls_and_messages'];
export const usesCalls = (use: AssignedUse): boolean => CALLS_USES.includes(use);

function columnsOf(n: ProviderNumber, now: Date) {
  return {
    e164: n.e164,
    status: n.status,
    voice: n.capabilities.voice,
    sms: n.capabilities.sms,
    mms: n.capabilities.mms,
    whatsapp: n.capabilities.whatsapp,
    tenDlcStatus: n.tenDlc,
    whatsappStatus: n.whatsapp,
    lastSyncedAt: now,
  };
}

/**
 * Reads the provider's numbers and upserts them on (org, provider, provider_number_id). A number
 * the provider no longer lists becomes `inactive` and `unassigned`; it is never deleted.
 */
export async function syncNumbers(
  tx: Tx,
  orgId: string,
  provider: NumberProviderKind,
  numbers: NumbersProvider,
  now: Date,
): Promise<SyncResult> {
  await lockNumbers(tx, orgId);
  const listed = await numbers.listNumbers();
  const existing = await tx.select().from(phoneNumber);
  const byProviderId = new Map(
    existing.filter((r) => r.provider === provider).map((r) => [r.providerNumberId, r]),
  );
  const byE164 = new Map(existing.map((r) => [r.e164, r]));
  const seen = new Set<string>();
  const result: SyncResult = { added: 0, updated: 0, deactivated: 0 };

  for (const n of listed) {
    const current = byProviderId.get(n.providerNumberId) ?? byE164.get(n.e164);
    if (current) {
      seen.add(current.id);
      await tx
        .update(phoneNumber)
        .set({ ...columnsOf(n, now), provider, providerNumberId: n.providerNumberId })
        .where(eq(phoneNumber.id, current.id));
      result.updated += 1;
    } else {
      const [created] = await tx
        .insert(phoneNumber)
        .values({
          organizationId: orgId,
          provider,
          providerNumberId: n.providerNumberId,
          ...columnsOf(n, now),
        })
        .returning({ id: phoneNumber.id });
      if (created) seen.add(created.id);
      result.added += 1;
    }
  }

  const gone = existing.filter(
    (r) => r.provider === provider && !seen.has(r.id) && r.status !== 'inactive',
  );
  if (gone.length > 0) {
    await tx
      .update(phoneNumber)
      .set({ status: 'inactive', assignedUse: 'unassigned', lastSyncedAt: now })
      .where(
        inArray(
          phoneNumber.id,
          gone.map((r) => r.id),
        ),
      );
    result.deactivated = gone.length;
  }
  // M3's live senders follow the synced numbers (ruling AQ); a fake sync has no telnyx numbers.
  if (provider === 'telnyx') await refreshTelnyxSenders(tx);
  return result;
}

export type AssignResult =
  | { kind: 'ok'; row: PhoneNumberRow }
  | { kind: 'not_found' }
  | { kind: 'invalid_state' };

/**
 * Sets how a number is used. A calls use is exclusive: any other number holding one loses it. A
 * provider number given a calls use becomes the caller id and claims its inbound route; the claim
 * throws NumberConflictError (rolling the transaction back) when another workspace owns it.
 */
export async function assignNumber(
  tx: Tx,
  tenant: Pick<Tenant, 'orgId'>,
  id: string,
  use: AssignedUse,
): Promise<AssignResult> {
  await lockNumbers(tx, tenant.orgId);
  const [row] = await tx.select().from(phoneNumber).where(eq(phoneNumber.id, id)).limit(1);
  if (!row) return { kind: 'not_found' };
  if (row.status !== 'active') return { kind: 'invalid_state' };

  if (usesCalls(use)) {
    await tx
      .update(phoneNumber)
      .set({ assignedUse: 'unassigned' })
      .where(and(eq(phoneNumber.assignedUse, 'calls'), ne(phoneNumber.id, id)));
    await tx
      .update(phoneNumber)
      .set({ assignedUse: 'messages' })
      .where(and(eq(phoneNumber.assignedUse, 'calls_and_messages'), ne(phoneNumber.id, id)));
    if (row.provider !== 'fake') {
      await claimNumber(tx, tenant.orgId, row.e164, row.provider);
      await tx
        .update(providerCredential)
        .set({ callerIdE164: row.e164 })
        .where(eq(providerCredential.provider, row.provider));
    }
  }
  const [updated] = await tx
    .update(phoneNumber)
    .set({ assignedUse: use })
    .where(eq(phoneNumber.id, id))
    .returning();
  if (!updated) return { kind: 'not_found' };
  return { kind: 'ok', row: updated };
}

import { ledgerEntry, type Tx, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { adjust, ensureWallet, LedgerError, walletSummary } from '../src/services/ledger';
import { get, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

async function newOrg(label: string): Promise<{ orgId: string; userId: string }> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  return { orgId, userId };
}

const inTenant = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withAppDb((db) => withTenant(db, orgId, fn));

const summaryOf = (orgId: string) =>
  inTenant(orgId, async (tx) =>
    walletSummary(tx, await ensureWallet(tx, orgId, { starterCredit: false }), new Date()),
  );

const input = (orgId: string, over: Partial<Parameters<typeof adjust>[1]> = {}) => ({
  orgId,
  balanceDeltaMicros: -30_000,
  note: 'Reconciliation test',
  idempotencyKey: 'adj-key-1',
  refType: 'reconciliation',
  refId: '2026-11-12:voice',
  actorUserId: null,
  ...over,
});

const adjustIn = (orgId: string, over?: Partial<Parameters<typeof adjust>[1]>) =>
  inTenant(orgId, async (tx) => {
    await ensureWallet(tx, orgId, { starterCredit: false });
    return adjust(tx, input(orgId, over));
  });

describe('adjust', () => {
  it('moves the balance by exactly the delta and leaves held alone', async () => {
    const { orgId } = await newOrg('adj-move');
    const before = await summaryOf(orgId);
    const { entry, created } = await adjustIn(orgId);
    expect(created).toBe(true);
    expect(entry).toMatchObject({
      kind: 'adjust',
      balanceDeltaMicros: -30_000,
      heldDeltaMicros: 0,
      refType: 'reconciliation',
    });
    const after = await summaryOf(orgId);
    expect(after.balanceMicros).toBe(before.balanceMicros - 30_000);
    expect(after.heldMicros).toBe(before.heldMicros);
  });

  it('replaying the same key and delta returns the first entry', async () => {
    const { orgId } = await newOrg('adj-replay');
    const first = await adjustIn(orgId);
    const again = await adjustIn(orgId);
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    const rows = await withAdminDb((db) =>
      db.select().from(ledgerEntry).where(eq(ledgerEntry.organizationId, orgId)),
    );
    expect(rows.filter((r) => r.kind === 'adjust')).toHaveLength(1);
  });

  it('refuses the same key with another delta', async () => {
    const { orgId } = await newOrg('adj-conflict');
    await adjustIn(orgId);
    await expect(adjustIn(orgId, { balanceDeltaMicros: -40_000 })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('refuses the same key used by another kind of entry', async () => {
    const { orgId } = await newOrg('adj-kind');
    await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
    await expect(
      adjustIn(orgId, { idempotencyKey: 'starter-credit', balanceDeltaMicros: 5_000_000 }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('refuses a zero or fractional delta', async () => {
    const { orgId } = await newOrg('adj-zero');
    await expect(adjustIn(orgId, { balanceDeltaMicros: 0 })).rejects.toMatchObject({
      code: 'invalid_amount',
    });
    await expect(adjustIn(orgId, { balanceDeltaMicros: 1.5 })).rejects.toMatchObject({
      code: 'invalid_amount',
    });
  });
});

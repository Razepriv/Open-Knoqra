import { ledgerEntry, type Tx, wallet, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  credit,
  ensureWallet,
  LedgerError,
  reserve,
  settleReservation,
  walletSummary,
} from '../src/services/ledger';
import { get, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

const STARTER = 5_000_000;
const NOW = new Date();

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

function inTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withAppDb((db) => withTenant(db, orgId, fn));
}

async function summaryOf(orgId: string) {
  return inTenant(orgId, async (tx) =>
    walletSummary(tx, await ensureWallet(tx, orgId, { starterCredit: false }), NOW),
  );
}

async function reserveIn(orgId: string, amountMicros: number, key: string) {
  return inTenant(orgId, async (tx) => {
    await ensureWallet(tx, orgId, { starterCredit: false });
    return reserve(tx, {
      orgId,
      amountMicros,
      idempotencyKey: key,
      refType: 'test',
      refId: key,
      actorUserId: null,
    });
  });
}

function reservedEntry(result: Awaited<ReturnType<typeof reserve>>) {
  if (!('entry' in result)) throw new Error(`refused: ${JSON.stringify(result.refused)}`);
  return result.entry;
}

describe('ledger service', () => {
  let orgId: string;

  beforeAll(async () => {
    ({ orgId } = await newOrg('ledger'));
  });

  it('adds the starter credit once across two ensureWallet calls', async () => {
    const first = await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
    const second = await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
    expect(second.id).toBe(first.id);
    const credits = await inTenant(orgId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.idempotencyKey, 'starter-credit')),
    );
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      kind: 'credit',
      balanceDeltaMicros: STARTER,
      heldDeltaMicros: 0,
      note: 'Development starter credit',
    });
    expect(await summaryOf(orgId)).toEqual({
      currency: 'USD',
      balanceMicros: STARTER,
      heldMicros: 0,
      availableMicros: STARTER,
      periodSpendMicros: 0,
      warnCapMicros: null,
      stopCapMicros: null,
      status: { outcome: 'ok', reason: 'ok' },
      dialStatus: { outcome: 'ok', reason: 'ok' },
    });
  });

  it('reserve then capture 20,000 leaves an exact summary', async () => {
    const entry = reservedEntry(await reserveIn(orgId, 100_000, 'cap-r'));
    expect(entry).toMatchObject({
      kind: 'reserve',
      balanceDeltaMicros: 0,
      heldDeltaMicros: 100_000,
    });
    expect(await summaryOf(orgId)).toMatchObject({
      balanceMicros: STARTER,
      heldMicros: 100_000,
      availableMicros: STARTER - 100_000,
      periodSpendMicros: 0,
    });
    const capture = await inTenant(orgId, (tx) =>
      settleReservation(tx, {
        orgId,
        reservationId: entry.id,
        costMicros: 20_000,
        idempotencyKey: 'cap-s',
        refType: 'test',
        refId: 'cap',
      }),
    );
    expect(capture).toMatchObject({
      kind: 'capture',
      balanceDeltaMicros: -20_000,
      heldDeltaMicros: -100_000,
      reservationId: entry.id,
    });
    expect(await summaryOf(orgId)).toMatchObject({
      balanceMicros: STARTER - 20_000,
      heldMicros: 0,
      availableMicros: STARTER - 20_000,
      periodSpendMicros: 20_000,
    });
  });

  it('reserve then release leaves an exact summary', async () => {
    const before = await summaryOf(orgId);
    const entry = reservedEntry(await reserveIn(orgId, 100_000, 'rel-r'));
    const release = await inTenant(orgId, (tx) =>
      settleReservation(tx, {
        orgId,
        reservationId: entry.id,
        costMicros: 0,
        idempotencyKey: 'rel-s',
        refType: 'test',
        refId: 'rel',
      }),
    );
    expect(release).toMatchObject({
      kind: 'release',
      balanceDeltaMicros: 0,
      heldDeltaMicros: -100_000,
    });
    expect(await summaryOf(orgId)).toEqual(before);
  });

  it('settling twice (same key or another key) returns the first settlement', async () => {
    const entry = reservedEntry(await reserveIn(orgId, 100_000, 'twice-r'));
    const settle = (key: string, cost: number) =>
      inTenant(orgId, (tx) =>
        settleReservation(tx, {
          orgId,
          reservationId: entry.id,
          costMicros: cost,
          idempotencyKey: key,
          refType: 'test',
          refId: 'twice',
        }),
      );
    const [a, b] = await Promise.all([settle('twice-s1', 10_000), settle('twice-s2', 0)]);
    expect(b.id).toBe(a.id);
    const again = await settle('twice-s1', 10_000);
    expect(again.id).toBe(a.id);
    const closes = await inTenant(orgId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.reservationId, entry.id)),
    );
    expect(closes).toHaveLength(1);
  });

  it('refuses to settle something that is not a reserve of this org', async () => {
    const other = await newOrg('ledger-other');
    const foreign = reservedEntry(await reserveInWithCredit(other.orgId, 'foreign-r'));
    const creditEntry = await inTenant(orgId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.idempotencyKey, 'starter-credit')),
    );
    for (const reservationId of [foreign.id, creditEntry[0]?.id ?? '', 'le_missing']) {
      await expect(
        inTenant(orgId, (tx) =>
          settleReservation(tx, {
            orgId,
            reservationId,
            costMicros: 0,
            idempotencyKey: `bad-${reservationId}`,
            refType: 'test',
            refId: 'bad',
          }),
        ),
      ).rejects.toBeInstanceOf(LedgerError);
    }
  });

  it('the same reserve idempotency key twice makes one entry', async () => {
    const a = reservedEntry(await reserveIn(orgId, 100_000, 'idem-r'));
    const b = reservedEntry(await reserveIn(orgId, 100_000, 'idem-r'));
    expect(b.id).toBe(a.id);
    const rows = await inTenant(orgId, (tx) =>
      tx.select().from(ledgerEntry).where(eq(ledgerEntry.idempotencyKey, 'idem-r')),
    );
    expect(rows).toHaveLength(1);
  });

  it('credits idempotently', async () => {
    const add = () =>
      inTenant(orgId, (tx) =>
        credit(tx, {
          orgId,
          amountMicros: 1_000,
          note: 'Top-up',
          idempotencyKey: 'credit-once',
          actorUserId: null,
        }),
      );
    const a = await add();
    const b = await add();
    expect(b.entry.id).toBe(a.entry.id);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });
});

async function reserveInWithCredit(orgId: string, key: string) {
  return inTenant(orgId, async (tx) => {
    await ensureWallet(tx, orgId, { starterCredit: true });
    return reserve(tx, {
      orgId,
      amountMicros: 100_000,
      idempotencyKey: key,
      refType: 'test',
      refId: key,
      actorUserId: null,
    });
  });
}

describe('ledger concurrency and caps', () => {
  it('5 concurrent reserves of 2,000,000 against 5,000,000 grant exactly 2', async () => {
    const { orgId } = await newOrg('ledger-race');
    await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => reserveIn(orgId, 2_000_000, `race-${i}`)),
    );
    const granted = results.filter((r) => 'entry' in r);
    const refused = results.filter((r) => 'refused' in r);
    expect(granted).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      if ('refused' in r)
        expect(r.refused).toEqual({ outcome: 'stop', reason: 'insufficient_funds' });
    }
    expect(await summaryOf(orgId)).toMatchObject({
      heldMicros: 4_000_000,
      availableMicros: 1_000_000,
    });
  });

  it('a stop cap of 50,000 refuses a 100,000 reserve with stop_cap', async () => {
    const { orgId } = await newOrg('ledger-cap');
    await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
    await withAdminDb((db) =>
      db.update(wallet).set({ stopCapMicros: 50_000 }).where(eq(wallet.organizationId, orgId)),
    );
    const result = await reserveIn(orgId, 100_000, 'cap-refused');
    expect(result).toEqual({ refused: { outcome: 'stop', reason: 'stop_cap' } });
    expect((await summaryOf(orgId)).heldMicros).toBe(0);
  });

  it('reports insufficient_funds when nothing is available', async () => {
    const { orgId } = await newOrg('ledger-empty');
    expect((await summaryOf(orgId)).status).toEqual({
      outcome: 'stop',
      reason: 'insufficient_funds',
    });
  });
});

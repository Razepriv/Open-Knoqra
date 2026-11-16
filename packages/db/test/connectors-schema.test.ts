import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  ledgerEntry,
  organization,
  providerCredential,
  providerEventRaw,
  wallet,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);

const ORGS = ['org_conn_a', 'org_conn_b'];

beforeAll(async () => {
  await runMigrations(migrationUrl);
  const now = new Date();
  await admin.db
    .insert(organization)
    .values(ORGS.map((id) => ({ id, name: id, slug: id.replace(/_/g, '-'), createdAt: now })))
    .onConflictDoNothing();
});

beforeEach(async () => {
  await admin.db.delete(providerCredential).where(inArray(providerCredential.organizationId, ORGS));
  await admin.db.delete(ledgerEntry).where(inArray(ledgerEntry.organizationId, ORGS));
  await admin.db.delete(wallet).where(inArray(wallet.organizationId, ORGS));
});

afterAll(async () => {
  await admin.db.delete(providerCredential).where(inArray(providerCredential.organizationId, ORGS));
  await admin.db.delete(ledgerEntry).where(inArray(ledgerEntry.organizationId, ORGS));
  await admin.db.delete(wallet).where(inArray(wallet.organizationId, ORGS));
  await admin.db.delete(organization).where(inArray(organization.id, ORGS));
  await app.close();
  await admin.close();
});

const sealed = {
  apiKeyCiphertext: 'ct',
  apiKeyIv: 'iv',
  dekWrapped: 'dw',
  dekIv: 'di',
  keyFingerprint: 'fp',
  apiKeyLast4: 'abcd',
};

describe('provider_credential as a connector', () => {
  it('stores a Plivo connection with its Auth ID', async () => {
    await withTenant(app.db, 'org_conn_a', (tx) =>
      tx.insert(providerCredential).values({
        organizationId: 'org_conn_a',
        provider: 'plivo',
        accountId: 'MAXXXXXXXXXXXXXXXXXX',
        connectionId: 'app-1',
        ...sealed,
      }),
    );
    const rows = await withTenant(app.db, 'org_conn_a', (tx) =>
      tx.select().from(providerCredential),
    );
    expect(rows.map((r) => [r.provider, r.accountId])).toEqual([['plivo', 'MAXXXXXXXXXXXXXXXXXX']]);
  });

  it('allows one connector per workspace, whatever the provider', async () => {
    await withTenant(app.db, 'org_conn_a', (tx) =>
      tx.insert(providerCredential).values({
        organizationId: 'org_conn_a',
        provider: 'telnyx',
        ...sealed,
      }),
    );
    const second = withTenant(app.db, 'org_conn_a', (tx) =>
      tx.insert(providerCredential).values({
        organizationId: 'org_conn_a',
        provider: 'plivo',
        ...sealed,
      }),
    );
    await expect(second).rejects.toSatisfy((e) =>
      pgMessage(e).includes('provider_credential_organization_id_unique'),
    );
    // Another workspace is unaffected.
    await withTenant(app.db, 'org_conn_b', (tx) =>
      tx.insert(providerCredential).values({
        organizationId: 'org_conn_b',
        provider: 'plivo',
        ...sealed,
      }),
    );
  });

  it('refuses a provider outside the registry', async () => {
    await expect(
      admin.db.execute(sql`
        insert into provider_credential (id, organization_id, provider, api_key_ciphertext,
          api_key_iv, dek_wrapped, dek_iv, key_fingerprint, api_key_last4)
        values ('pc_bad', 'org_conn_a', 'twilio', 'ct', 'iv', 'dw', 'di', 'fp', 'abcd')`),
    ).rejects.toSatisfy((e) => pgMessage(e).includes('provider_credential_provider_check'));
  });
});

describe('ledger fee entries', () => {
  async function walletOf(orgId: string) {
    const [row] = await admin.db.insert(wallet).values({ organizationId: orgId }).returning();
    if (!row) throw new Error('no wallet');
    return row;
  }
  const fee = (orgId: string, walletId: string, over: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    walletId,
    kind: 'fee' as const,
    balanceDeltaMicros: -4_000,
    heldDeltaMicros: 0,
    refType: 'call',
    refId: 'call_1',
    idempotencyKey: `call:call_1:fee:${Math.random()}`,
    ...over,
  });

  it('accepts a plain debit through the app role', async () => {
    const w = await walletOf('org_conn_a');
    await withTenant(app.db, 'org_conn_a', (tx) =>
      tx.insert(ledgerEntry).values(fee('org_conn_a', w.id)),
    );
    const rows = await admin.db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.organizationId, 'org_conn_a'));
    expect(rows.map((r) => [r.kind, r.balanceDeltaMicros])).toEqual([['fee', -4_000]]);
  });

  it('refuses a fee that credits, holds or closes a reservation', async () => {
    const w = await walletOf('org_conn_a');
    for (const bad of [
      { balanceDeltaMicros: 4_000 },
      { balanceDeltaMicros: 0 },
      { heldDeltaMicros: -4_000 },
      { reservationId: 'le_x' },
    ]) {
      await expect(
        admin.db.insert(ledgerEntry).values(fee('org_conn_a', w.id, bad)),
      ).rejects.toSatisfy((e) =>
        /ledger_entry_kind_signs|ledger_entry_reservation_fk/.test(pgMessage(e)),
      );
    }
  });
});

describe('provider_event_raw.organization_id', () => {
  it('is optional', async () => {
    const id = `pe_conn_${Date.now()}`;
    await admin.db.insert(providerEventRaw).values({
      id,
      provider: 'plivo',
      externalEventId: `org_conn_a:${id}`,
      eventType: 'call.completed',
      body: {},
      organizationId: 'org_conn_a',
    });
    const [row] = await admin.db
      .select({ organizationId: providerEventRaw.organizationId })
      .from(providerEventRaw)
      .where(eq(providerEventRaw.id, id));
    expect(row?.organizationId).toBe('org_conn_a');
    await admin.db.delete(providerEventRaw).where(eq(providerEventRaw.id, id));
  });
});

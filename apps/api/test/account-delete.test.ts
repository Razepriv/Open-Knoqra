import {
  auditEvent,
  contact,
  ledgerEntry,
  member,
  organization,
  phoneNumber,
  providerCredential,
  session,
  user,
  wallet,
} from '@knoqra/db';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  api,
  get,
  PASSWORD,
  post,
  saveTelnyxCredential,
  seedSyncedNumber,
  signUp,
  signUpTeammate,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

interface Me {
  data: { user: { id: string }; organization: { id: string } };
}

async function whoAmI(cookie: string): Promise<{ userId: string; orgId: string }> {
  const r = await get('/api/v1/me', cookie);
  expect(r.status).toBe(200);
  const me = (await r.json()) as Me;
  return { userId: me.data.user.id, orgId: me.data.organization.id };
}

function deleteMe(cookie: string, password: string): Promise<Response> {
  return api('/api/v1/me', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ password }),
  });
}

async function addContact(cookie: string, name: string): Promise<void> {
  const phone = `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`;
  const r = await post('/api/v1/contacts', cookie, { displayName: name, phone });
  expect(r.status).toBe(201);
}

const userExists = (userId: string) =>
  withAdminDb(async (db) => (await db.select().from(user).where(eq(user.id, userId))).length > 0);

const contactCount = (orgId: string) =>
  withAdminDb(
    async (db) => (await db.select().from(contact).where(eq(contact.organizationId, orgId))).length,
  );

describe('DELETE /api/v1/me', () => {
  it('refuses a wrong password and changes nothing', async () => {
    const cookie = await signUp(uniqueEmail('del-wrong'), 'Wrong Password');
    const { userId, orgId } = await whoAmI(cookie);
    await addContact(cookie, 'Kept Contact');

    const r = await deleteMe(cookie, 'not-the-password');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('invalid_password');
    expect(await userExists(userId)).toBe(true);
    expect(await contactCount(orgId)).toBe(1);
    expect((await get('/api/v1/me', cookie)).status).toBe(200);
  });

  it('closes a personal workspace: data deleted, money records kept anonymised, signed out', async () => {
    const cookie = await signUp(uniqueEmail('del-solo'), 'Solo Owner');
    const { userId, orgId } = await whoAmI(cookie);
    await addContact(cookie, 'Gone Contact');
    // Opens the wallet (starter credit), then a manual adjustment with a free-text note.
    expect((await get('/api/v1/wallet', cookie)).status).toBe(200);
    await withAdminDb(async (db) => {
      const [w] = await db.select().from(wallet).where(eq(wallet.organizationId, orgId));
      if (!w) throw new Error('wallet missing');
      await db.insert(ledgerEntry).values({
        organizationId: orgId,
        walletId: w.id,
        kind: 'adjust',
        balanceDeltaMicros: 0,
        heldDeltaMicros: 0,
        idempotencyKey: `test-note-${crypto.randomUUID()}`,
        note: 'Refund for Solo Owner',
      });
    });

    const r = await deleteMe(cookie, PASSWORD);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ data: { deleted: true }, error: null });

    // Signed out everywhere: the session row went with the user.
    expect((await get('/api/v1/me', cookie)).status).toBe(401);
    expect(await userExists(userId)).toBe(false);
    expect(await contactCount(orgId)).toBe(0);

    await withAdminDb(async (db) => {
      const sessions = await db.select().from(session).where(eq(session.userId, userId));
      expect(sessions).toHaveLength(0);
      const members = await db.select().from(member).where(eq(member.organizationId, orgId));
      expect(members).toHaveLength(0);

      const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
      expect(org?.name).toBe('Closed workspace');
      expect(org?.slug).toBe(`closed-${orgId.toLowerCase()}`);
      expect(JSON.parse(org?.metadata ?? '{}')).toHaveProperty('closedAt');

      const entries = await db
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.organizationId, orgId));
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries.every((e) => e.note === null)).toBe(true);
      const [w] = await db.select().from(wallet).where(eq(wallet.organizationId, orgId));
      expect(w).toBeDefined();

      const audits = await db
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.organizationId, orgId), eq(auditEvent.action, 'user.account.delete')),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.metadata).toEqual({ workspace: 'closed' });
    });
  });

  it('removes the provider credential of a closed workspace and keeps its numbers', async () => {
    const cookie = await signUp(uniqueEmail('del-cred'), 'Credential Owner');
    const { orgId } = await whoAmI(cookie);
    await saveTelnyxCredential(orgId, null);
    await seedSyncedNumber(orgId, `+1202555${String(Math.floor(1000 + Math.random() * 8999))}`);

    expect((await deleteMe(cookie, PASSWORD)).status).toBe(200);
    await withAdminDb(async (db) => {
      const credentials = await db
        .select()
        .from(providerCredential)
        .where(eq(providerCredential.organizationId, orgId));
      expect(credentials).toHaveLength(0);
      const numbers = await db
        .select()
        .from(phoneNumber)
        .where(eq(phoneNumber.organizationId, orgId));
      expect(numbers).toHaveLength(1);
    });
  });

  it('refuses when the user is the only owner of a workspace other people use', async () => {
    const cookie = await signUp(uniqueEmail('del-team-owner'), 'Team Owner');
    const { userId, orgId } = await whoAmI(cookie);
    await signUpTeammate(orgId);
    await addContact(cookie, 'Team Contact');

    const r = await deleteMe(cookie, PASSWORD);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      'sole_owner_with_members',
    );
    expect(await userExists(userId)).toBe(true);
    expect(await contactCount(orgId)).toBe(1);
  });

  it('leaves a workspace that has an owner, keeping its data, and closes the personal one', async () => {
    const ownerCookie = await signUp(uniqueEmail('del-host'), 'Host Owner');
    const host = await whoAmI(ownerCookie);
    await addContact(ownerCookie, 'Host Contact');
    const mate = await signUpTeammate(host.orgId);
    // The teammate's own personal workspace, from sign-up.
    const personal = await withAdminDb(async (db) => {
      const rows = await db
        .select({ orgId: member.organizationId })
        .from(member)
        .where(eq(member.userId, mate.userId));
      return rows.map((r) => r.orgId).find((id) => id !== host.orgId);
    });
    expect(personal).toBeDefined();

    const r = await deleteMe(mate.cookie, PASSWORD);
    expect(r.status).toBe(200);
    expect(await userExists(mate.userId)).toBe(false);

    await withAdminDb(async (db) => {
      const [hostOrg] = await db.select().from(organization).where(eq(organization.id, host.orgId));
      expect(hostOrg?.name).not.toBe('Closed workspace');
      const hostMembers = await db
        .select()
        .from(member)
        .where(eq(member.organizationId, host.orgId));
      expect(hostMembers.map((m) => m.userId)).toEqual([host.userId]);
      const [closed] = await db
        .select()
        .from(organization)
        .where(eq(organization.id, personal as string));
      expect(closed?.name).toBe('Closed workspace');
      const left = await db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, host.orgId),
            eq(auditEvent.action, 'user.account.delete'),
          ),
        );
      expect(left[0]?.metadata).toEqual({ workspace: 'left' });
    });
    expect(await contactCount(host.orgId)).toBe(1);
    expect((await get('/api/v1/me', ownerCookie)).status).toBe(200);
  });

  it('keeps Better Auth delete-user switched off, so there is one deletion path', async () => {
    const cookie = await signUp(uniqueEmail('del-ba'), 'Better Auth');
    const r = await api('/api/auth/delete-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:8787' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(r.status).toBe(404);
  });

  it('lets the app role close a workspace only inside its tenant transaction', async () => {
    const cookie = await signUp(uniqueEmail('del-guard'), 'Guarded');
    const { orgId } = await whoAmI(cookie);
    await expect(
      withAppDb((db) => db.execute(sql`select public.knoqra_close_workspace(${orgId}, false)`)),
    ).rejects.toThrow();
    expect(await contactCount(orgId)).toBe(0);
    await withAdminDb(async (db) => {
      const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
      expect(org?.name).not.toBe('Closed workspace');
    });
  });
});

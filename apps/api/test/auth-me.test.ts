import { member, organization, session, user } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sentEmails } from '../src/lib/email';
import {
  api,
  authPost,
  BASE,
  cookieHeader,
  get,
  PASSWORD,
  signIn,
  signUp,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

type MeBody = {
  data: {
    user: { id: string; name: string; email: string };
    organization: { id: string; name: string; role: string };
  } | null;
  error: { code: string; message: string } | null;
};

async function userIdByEmail(email: string): Promise<string> {
  const [row] = await withAppDb((db) =>
    db.select({ id: user.id }).from(user).where(eq(user.email, email)),
  );
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

describe('sign-up and /api/v1/me', () => {
  it('sign-up creates a personal workspace visible in /me', async () => {
    const email = uniqueEmail('ana');
    const cookie = await signUp(email, 'Ana Silva');
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeBody;
    expect(body.error).toBeNull();
    expect(body.data?.user).toEqual({ id: expect.any(String), name: 'Ana Silva', email });
    expect(body.data?.organization).toMatchObject({
      id: expect.any(String),
      name: "Ana Silva's workspace",
      role: 'owner',
    });
  });

  it('the workspace slug is derived from the user id', async () => {
    const email = uniqueEmail('slug');
    const cookie = await signUp(email, 'Slug Person');
    const body = (await (await get('/api/v1/me', cookie)).json()) as MeBody;
    const userId = await userIdByEmail(email);
    const memberships = await withAppDb((db) =>
      db.query.member.findMany({ where: eq(member.userId, userId), with: { organization: true } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.organization).toMatchObject({
      id: body.data?.organization.id,
      slug: `ws-${userId.toLowerCase()}`,
    });
  });

  it('a later sign-in starts a session on the first membership', async () => {
    const email = uniqueEmail('return');
    await signUp(email, 'Returning User');
    const cookie = await signIn(email);
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as MeBody).data?.organization.name).toBe("Returning User's workspace");
  });

  it('rejects unauthenticated /me with 401 envelope', async () => {
    const r = await get('/api/v1/me');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'unauthenticated', message: expect.any(String) },
    });
  });

  it('rejects a forged session cookie with 401', async () => {
    const r = await get('/api/v1/me', 'better-auth.session_token=forged.value');
    expect(r.status).toBe(401);
  });

  it('409 when the user is no longer a member of the active organization', async () => {
    const email = uniqueEmail('removed');
    const cookie = await signUp(email, 'Removed User');
    const userId = await userIdByEmail(email);
    await withAppDb((db) => db.delete(member).where(eq(member.userId, userId)));
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(409);
    expect(((await r.json()) as MeBody).error?.code).toBe('no_active_org');
  });

  it('409 when the session has no active organization', async () => {
    const email = uniqueEmail('noorg');
    const cookie = await signUp(email, 'No Org');
    const userId = await userIdByEmail(email);
    await withAppDb((db) =>
      db.update(session).set({ activeOrganizationId: null }).where(eq(session.userId, userId)),
    );
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(409);
    expect(((await r.json()) as MeBody).error?.code).toBe('no_active_org');
  });
});

describe('personal workspace recovery', () => {
  it('a user who lost their workspace gets it back on the next sign-in', async () => {
    const email = uniqueEmail('lost');
    await signUp(email, 'Lost Workspace');
    const userId = await userIdByEmail(email);
    // Simulates a failed user.create.after hook: a committed user with no membership or org.
    await withAdminDb(async (db) => {
      await db.delete(member).where(eq(member.userId, userId));
      await db.delete(organization).where(eq(organization.slug, `ws-${userId.toLowerCase()}`));
    });

    const cookie = await signIn(email);
    const r = await get('/api/v1/me', cookie);
    expect(r.status).toBe(200);
    expect(((await r.json()) as MeBody).data?.organization).toMatchObject({
      name: "Lost Workspace's workspace",
      role: 'owner',
    });
    const memberships = await withAppDb((db) =>
      db.select().from(member).where(eq(member.userId, userId)),
    );
    expect(memberships).toHaveLength(1);
  });

  it('a sign-in after losing only the membership rejoins the existing workspace', async () => {
    const email = uniqueEmail('rejoin');
    const first = await signUp(email, 'Rejoin User');
    const before = (await (await get('/api/v1/me', first)).json()) as MeBody;
    const userId = await userIdByEmail(email);
    await withAdminDb((db) => db.delete(member).where(eq(member.userId, userId)));

    const r = await get('/api/v1/me', await signIn(email));
    expect(r.status).toBe(200);
    expect(((await r.json()) as MeBody).data?.organization).toMatchObject({
      id: before.data?.organization.id,
      role: 'owner',
    });
  });

  it('users cannot create additional organizations in M0', async () => {
    const cookie = await signUp(uniqueEmail('creator'), 'Org Creator');
    const r = await api('/api/auth/organization/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
      body: JSON.stringify({ name: 'Side Project', slug: `side-${crypto.randomUUID()}` }),
    });
    expect([403, 404]).toContain(r.status);
  });
});

describe('email and password policy', () => {
  it('rejects passwords shorter than 12 characters', async () => {
    const r = await authPost('/api/auth/sign-up/email', {
      email: uniqueEmail('short'),
      password: 'elevenchars',
      name: 'Short Password',
    });
    expect(r.status).toBe(400);
  });

  it('sends the password reset link through the email sender', async () => {
    const email = uniqueEmail('reset');
    await signUp(email, 'Reset User');
    const before = sentEmails.length;
    const r = await authPost('/api/auth/request-password-reset', {
      email,
      redirectTo: '/reset-password',
    });
    expect(r.status).toBe(200);
    const sent = sentEmails.slice(before).filter((m) => m.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('/reset-password');
  });

  it('signs out every session when the password is reset', async () => {
    const email = uniqueEmail('reset-revoke');
    await signUp(email, 'Reset Revoke');
    const otherDevice = await signIn(email);
    expect((await get('/api/v1/me', otherDevice)).status).toBe(200);

    const before = sentEmails.length;
    await authPost('/api/auth/request-password-reset', { email, redirectTo: '/reset-password' });
    const text = sentEmails.slice(before).find((m) => m.to === email)?.text ?? '';
    const token = /reset-password\/([^?\s]+)/.exec(text)?.[1];
    expect(token).toBeTruthy();

    const reset = await authPost('/api/auth/reset-password', {
      token,
      newPassword: 'a-brand-new-password-123',
    });
    expect(reset.status).toBe(200);
    expect((await get('/api/v1/me', otherDevice)).status).toBe(401);
  });
});

describe('display name rules on the Better Auth endpoints', () => {
  const signUpWith = (name: string) =>
    authPost('/api/auth/sign-up/email', {
      email: uniqueEmail('name-rule'),
      password: PASSWORD,
      name,
    });

  it('rejects a sign-up name longer than 120 characters with 400', async () => {
    const r = await signUpWith('a'.repeat(121));
    expect(r.status).toBe(400);
    // The web sign-up form keys its name-field error on this message (signUpErrorMessage).
    const body = (await r.json()) as { message?: string };
    expect(body.message).toMatch(/\bname\b/i);
  });

  it('rejects a sign-up name holding a NUL byte with 400, not 500', async () => {
    const r = await signUpWith('a\u0000b');
    expect(r.status).toBe(400);
  });

  it('rejects a blank sign-up name with 400', async () => {
    const r = await signUpWith('   ');
    expect(r.status).toBe(400);
  });

  it('accepts a 120-character name and stores it trimmed', async () => {
    const name = 'b'.repeat(120);
    const r = await signUpWith(`  ${name}  `);
    expect(r.status).toBe(200);
    const cookie = cookieHeader(r);
    const me = (await (await get('/api/v1/me', cookie)).json()) as MeBody;
    expect(me.data?.user.name).toBe(name);
  });

  it('answers 404 on /api/auth/update-user, so names change only through PATCH /api/v1/me', async () => {
    const cookie = await signUp(uniqueEmail('update-user'), 'Before');
    const r = await api('/api/auth/update-user', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ name: 'x'.repeat(200) }),
    });
    expect(r.status).toBe(404);
    const me = (await (await get('/api/v1/me', cookie)).json()) as MeBody;
    expect(me.data?.user.name).toBe('Before');
  });
});

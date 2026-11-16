import { auditEvent } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { api, BASE, get, signIn, signUp, uniqueEmail, withAdminDb } from './helpers';

type Prefs = {
  timezone: string | null;
  theme: 'system' | 'light' | 'dark';
  notifyEmail: boolean;
  notifyDesktop: boolean;
  analyticsConsent: boolean;
  newsletter: boolean;
};
type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type MeBody = Envelope<{ user: { id: string; name: string }; prefs: Prefs }>;

const DEFAULTS: Prefs = {
  timezone: null,
  theme: 'system',
  notifyEmail: true,
  notifyDesktop: true,
  analyticsConsent: false,
  newsletter: false,
};

function patch(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function prefsOf(cookie: string): Promise<Prefs> {
  const r = await get('/api/v1/me/prefs', cookie);
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<Prefs>).data as Prefs;
}

async function auditsFor(userId: string, action: string) {
  return withAdminDb((db) =>
    db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.actorUserId, userId), eq(auditEvent.action, action))),
  );
}

async function meOf(cookie: string) {
  return ((await (await get('/api/v1/me', cookie)).json()) as MeBody).data;
}

describe('GET/PATCH /api/v1/me/prefs', () => {
  it('returns the defaults for a new user, in /me too', async () => {
    const cookie = await signUp(uniqueEmail('pd'), 'Prefs Default');
    expect(await prefsOf(cookie)).toEqual(DEFAULTS);
    expect((await meOf(cookie))?.prefs).toEqual(DEFAULTS);
  });

  it('persists a partial PATCH and the next GET returns it', async () => {
    const cookie = await signUp(uniqueEmail('pp'), 'Prefs Patch');
    const r = await patch('/api/v1/me/prefs', cookie, { theme: 'dark', timezone: 'Europe/Lisbon' });
    expect(r.status).toBe(200);
    const expected = { ...DEFAULTS, theme: 'dark', timezone: 'Europe/Lisbon' };
    expect(((await r.json()) as Envelope<Prefs>).data).toEqual(expected);
    expect(await prefsOf(cookie)).toEqual(expected);

    // A second partial PATCH leaves earlier fields alone; null clears the timezone.
    const r2 = await patch('/api/v1/me/prefs', cookie, { notifyEmail: false, timezone: null });
    expect(r2.status).toBe(200);
    expect(await prefsOf(cookie)).toEqual({
      timezone: null,
      theme: 'dark',
      notifyEmail: false,
      notifyDesktop: true,
      analyticsConsent: false,
      newsletter: false,
    });
    expect((await meOf(cookie))?.prefs.theme).toBe('dark');
  });

  it('an empty PATCH is a no-op that returns the current prefs', async () => {
    const cookie = await signUp(uniqueEmail('pe'), 'Prefs Empty');
    const r = await patch('/api/v1/me/prefs', cookie, {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Prefs>).data).toEqual(DEFAULTS);
  });

  it.each([
    ['unknown zone', { timezone: 'Mars/Base' }],
    ['numeric offset', { timezone: '+05:00' }],
    ['empty zone', { timezone: '' }],
    ['NUL in zone', { timezone: 'Europe/Lis\u0000bon' }],
    ['bad theme', { theme: 'neon' }],
    ['non-boolean', { notifyEmail: 'yes' }],
    ['non-boolean consent', { analyticsConsent: 'yes' }],
  ])('rejects %s with 400 validation_error', async (_label, body) => {
    const cookie = await signUp(uniqueEmail('pv'), 'Prefs Invalid');
    const r = await patch('/api/v1/me/prefs', cookie, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Prefs>).error?.code).toBe('validation_error');
    expect(await prefsOf(cookie)).toEqual(DEFAULTS);
  });

  it('prefs are per user: A changing theirs never shows for B', async () => {
    const a = await signUp(uniqueEmail('pa'), 'User A');
    const b = await signUp(uniqueEmail('pb'), 'User B');
    await patch('/api/v1/me/prefs', a, { theme: 'light', notifyDesktop: false });
    expect(await prefsOf(b)).toEqual(DEFAULTS);
    await patch('/api/v1/me/prefs', b, { theme: 'dark' });
    expect((await prefsOf(a)).theme).toBe('light');
    expect((await prefsOf(b)).theme).toBe('dark');
  });

  it('ignores a userId smuggled into the body (session user only)', async () => {
    const a = await signUp(uniqueEmail('ua'), 'User A');
    const b = await signUp(uniqueEmail('ub'), 'User B');
    const bId = (await meOf(b))?.user.id;
    await patch('/api/v1/me/prefs', a, { userId: bId, theme: 'dark' });
    expect(await prefsOf(b)).toEqual(DEFAULTS);
    expect((await prefsOf(a)).theme).toBe('dark');
  });

  it('opts in to analytics and audits the field name only', async () => {
    const cookie = await signUp(uniqueEmail('ac'), 'Consent');
    const userId = (await meOf(cookie))?.user.id as string;
    const r = await patch('/api/v1/me/prefs', cookie, { analyticsConsent: true });
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Prefs>).data?.analyticsConsent).toBe(true);
    expect((await prefsOf(cookie)).analyticsConsent).toBe(true);
    const rows = await auditsFor(userId, 'user.prefs.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ fields: ['analyticsConsent'] });
  });

  it('requires a session', async () => {
    expect((await get('/api/v1/me/prefs')).status).toBe(401);
    const r = await api('/api/v1/me/prefs', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"theme":"dark"}',
    });
    expect(r.status).toBe(401);
  });

  it('audits a prefs write with field names only, never values', async () => {
    const cookie = await signUp(uniqueEmail('au'), 'Audited');
    const userId = (await meOf(cookie))?.user.id as string;
    await patch('/api/v1/me/prefs', cookie, { timezone: 'Asia/Tokyo', theme: 'dark' });
    const rows = await auditsFor(userId, 'user.prefs.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'allowed', entityType: 'user', entityId: userId });
    expect(rows[0]?.metadata).toEqual({ fields: ['theme', 'timezone'] });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Tokyo');
    // A rejected write is not audited as an update.
    await patch('/api/v1/me/prefs', cookie, { timezone: 'Mars/Base' });
    expect(await auditsFor(userId, 'user.prefs.update')).toHaveLength(1);
  });
});

describe('PATCH /api/v1/me (profile)', () => {
  it('updates the display name and returns Me', async () => {
    const cookie = await signUp(uniqueEmail('pn'), 'Old Name');
    const r = await patch('/api/v1/me', cookie, { name: '  New Name  ' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeBody;
    expect(body.data?.user.name).toBe('New Name');
    expect(body.data?.prefs).toEqual(DEFAULTS);
    expect((await meOf(cookie))?.user.name).toBe('New Name');
  });

  it('audits the change with the field name only', async () => {
    const cookie = await signUp(uniqueEmail('pq'), 'Before');
    const userId = (await meOf(cookie))?.user.id as string;
    await patch('/api/v1/me', cookie, { name: 'Secret Rename' });
    const rows = await auditsFor(userId, 'user.profile.update');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ fields: ['name'] });
  });

  it.each([
    ['empty', { name: '' }],
    ['blank', { name: '   ' }],
    ['too long', { name: 'x'.repeat(121) }],
    ['NUL', { name: 'bad\u0000name' }],
    ['missing', {}],
    ['wrong type', { name: 5 }],
  ])('rejects a %s name with 400', async (_label, body) => {
    const cookie = await signUp(uniqueEmail('pr'), 'Keep Me');
    const r = await patch('/api/v1/me', cookie, body);
    expect(r.status).toBe(400);
    expect((await meOf(cookie))?.user.name).toBe('Keep Me');
  });

  it('only changes the session user', async () => {
    const a = await signUp(uniqueEmail('ra'), 'Name A');
    const b = await signUp(uniqueEmail('rb'), 'Name B');
    await patch('/api/v1/me', a, { name: 'Renamed A' });
    expect((await meOf(a))?.user.name).toBe('Renamed A');
    expect((await meOf(b))?.user.name).toBe('Name B');
  });

  it('requires a session', async () => {
    const r = await api('/api/v1/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"x"}',
    });
    expect(r.status).toBe(401);
  });
});

describe('revoked sessions', () => {
  function sessionToken(cookie: string): string {
    const pair = cookie.split('; ').find((c) => c.startsWith('better-auth.session_token='));
    if (!pair) throw new Error('no session cookie');
    return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).split('.')[0] as string;
  }

  it('gets 401 on /me, prefs and profile after another session revokes it', async () => {
    const email = uniqueEmail('rev');
    const first = await signUp(email, 'Revoked');
    const second = await signIn(email);
    expect((await get('/api/v1/me', first)).status).toBe(200);

    const revoke = await api('/api/auth/revoke-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: second },
      body: JSON.stringify({ token: sessionToken(first) }),
    });
    expect(revoke.status).toBe(200);

    for (const path of ['/api/v1/me', '/api/v1/me/prefs']) {
      expect((await get(path, first)).status).toBe(401);
    }
    expect((await patch('/api/v1/me/prefs', first, { theme: 'dark' })).status).toBe(401);
    expect((await patch('/api/v1/me', first, { name: 'Nope' })).status).toBe(401);
    expect((await get('/api/v1/me', second)).status).toBe(200);
  });
});

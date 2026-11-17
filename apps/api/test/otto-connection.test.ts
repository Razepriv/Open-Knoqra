import { env } from 'cloudflare:workers';
import { aiCredential, member, usageEvent, user, withTenant } from '@knoqra/db';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { OWN_CONNECTION_DAILY_LIMIT, resolveOttoAccess } from '../src/otto/access';
import { saveOttoCredential } from '../src/otto/connection';
import { api, BASE, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Status = {
  mode: string;
  connection: { kind: string; last4: string | null; model: string } | null;
  dailyLimit: number | null;
  usedToday: number;
  canManage: boolean;
  chatgptSignIn: boolean;
};
const bindings = env as unknown as Env;

async function newOrg(label: string) {
  const cookie = await signUp(uniqueEmail(label));
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  return { cookie, orgId: me.data?.organization.id as string, userId: me.data?.user.id as string };
}

async function newContact(cookie: string, name: string): Promise<string> {
  const r = await post('/api/v1/contacts', cookie, {
    displayName: name,
    phone: `+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`,
  });
  return ((await r.json()) as Envelope<{ id: string }>).data?.id as string;
}

const send = (path: string, cookie: string, method: 'PUT' | 'DELETE', body?: unknown) =>
  api(path, {
    method,
    headers: { cookie, 'content-type': 'application/json', origin: BASE },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function status(cookie: string): Promise<Status> {
  const body = (await (await get('/api/v1/otto/connection', cookie)).json()) as Envelope<Status>;
  if (!body.data) throw new Error(JSON.stringify(body.error));
  return body.data;
}

/** Splits a server-sent event stream into its events. */
function events(raw: string): { event: string; data: unknown }[] {
  return raw
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event =
        lines
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim() ?? 'message';
      const data = lines
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}

describe('Settings → Otto status', () => {
  it('shows the test instance mock, the limit and what can be managed', async () => {
    const org = await newOrg('otto-status');
    expect(await status(org.cookie)).toEqual({
      mode: 'demo',
      connection: null,
      plan: null,
      upgradePath: null,
      dailyLimit: 50,
      usedToday: 0,
      canManage: true,
      chatgptSignIn: false,
      earlyAccess: false,
    });
  });

  it('refuses a malformed key without calling OpenAI, and hides ChatGPT sign-in', async () => {
    const org = await newOrg('otto-badkey');
    for (const apiKey of ['short', 'sk-has a space in it somewhere']) {
      const r = await send('/api/v1/otto/connection/key', org.cookie, 'PUT', { apiKey });
      expect(r.status).toBe(400);
    }
    const start = await post('/api/v1/otto/connection/chatgpt', org.cookie, {});
    expect(start.status).toBe(404);
  });

  it('stores an own key sealed, uses it first, shows only its last four, and disconnects', async () => {
    const org = await newOrg('otto-ownkey');
    const apiKey = `sk-test-${crypto.randomUUID().replaceAll('-', '')}`;
    await withAppDb((db) =>
      withTenant(db, org.orgId, (tx) =>
        saveOttoCredential(tx, {
          orgId: org.orgId,
          userId: org.userId,
          masterKeyBase64: bindings.CREDENTIALS_MASTER_KEY as string,
          kind: 'api_key',
          secret: apiKey,
          model: null,
          expiresAt: null,
        }),
      ),
    );
    const [stored] = await withAdminDb((db) => db.select().from(aiCredential));
    expect(JSON.stringify(stored)).not.toContain(apiKey);

    const access = await withAppDb((db) =>
      withTenant(db, org.orgId, (tx) => resolveOttoAccess(tx, bindings)),
    );
    expect(access).toMatchObject({
      ready: true,
      mode: 'own_key',
      providerName: 'openai',
      dailyLimit: OWN_CONNECTION_DAILY_LIMIT,
      connection: { kind: 'api_key', apiKey, baseUrl: 'https://api.openai.com/v1' },
    });

    const shown = await status(org.cookie);
    expect(shown).toMatchObject({
      mode: 'own_key',
      connection: { kind: 'api_key', last4: apiKey.slice(-4), model: 'gpt-6-luna' },
      dailyLimit: OWN_CONNECTION_DAILY_LIMIT,
    });
    expect(JSON.stringify(shown)).not.toContain(apiKey.slice(0, -4));

    // Another workspace cannot read it: row-level security.
    const other = await newOrg('otto-ownkey-other');
    expect((await status(other.cookie)).mode).toBe('demo');

    const r = await send('/api/v1/otto/connection', org.cookie, 'DELETE');
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Status>).data).toMatchObject({
      mode: 'demo',
      connection: null,
    });
  });

  it('asks to connect when there is no instance model', async () => {
    const org = await newOrg('otto-none');
    const access = await withAppDb((db) =>
      withTenant(db, org.orgId, (tx) =>
        resolveOttoAccess(tx, { ...bindings, APP_ENV: 'staging', AI_PROVIDER: '' }),
      ),
    );
    expect(access).toEqual({ ready: false, mode: 'connect', plan: null, upgradePath: null });
  });
});

describe('streamed Otto answers', () => {
  it('streams deltas, then the stored draft', async () => {
    const org = await newOrg('otto-stream');
    const ct = await newContact(org.cookie, 'Stream Contact');
    const r = await post('/api/v1/otto/drafts/stream', org.cookie, {
      kind: 'brief',
      contactId: ct,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const all = events(await r.text());
    const deltas = all
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { text: string }).text);
    const done = all.at(-1);
    expect(done?.event).toBe('done');
    const draft = done?.data as { id: string; text: string; kind: string };
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(draft.text);
    expect(draft.kind).toBe('brief');
    expect((await status(org.cookie)).usedToday).toBe(1);
  });

  it('answers the same JSON errors before streaming starts', async () => {
    const a = await newOrg('otto-stream-a');
    const b = await newOrg('otto-stream-b');
    const ct = await newContact(a.cookie, 'Private Contact');
    const r = await post('/api/v1/otto/drafts/stream', b.cookie, { kind: 'brief', contactId: ct });
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('counts the whole workspace against the daily limit', async () => {
    const org = await newOrg('otto-workspace-limit');
    const mateId = `mate-${crypto.randomUUID().slice(0, 8)}`;
    await withAdminDb(async (db) => {
      await db
        .insert(user)
        .values({ id: mateId, name: 'Mate', email: `${mateId}@example.test`, emailVerified: true });
      await db.insert(member).values({
        id: `m-${mateId}`,
        organizationId: org.orgId,
        userId: mateId,
        createdAt: new Date(),
      });
      await db.insert(usageEvent).values(
        Array.from({ length: 50 }, (_, i) => ({
          organizationId: org.orgId,
          userId: mateId,
          service: 'ai' as const,
          quantity: 1,
          unit: 'request',
          provider: 'mock',
          idempotencyKey: `seed:${i}`,
        })),
      );
    });
    const ct = await newContact(org.cookie, 'Limit Contact');
    const r = await post('/api/v1/otto/drafts/stream', org.cookie, {
      kind: 'brief',
      contactId: ct,
    });
    expect(r.status).toBe(429);
  });
});

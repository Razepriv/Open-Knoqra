import {
  auditEvent,
  member,
  type ProviderCredentialRow,
  providerCredential,
  providerNumberRoute,
} from '@knoqra/db';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  issueTelnyxToken,
  selectVoiceProvider,
  VoiceUpstreamError,
} from '../src/lib/voice-provider';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Connection = {
  provider: 'telnyx';
  apiKeyLast4: string;
  connectionId: string | null;
  callerIdE164: string | null;
  updatedAt: string;
};

const API_KEY = 'KEY0TESTONLY1234567890abcdef';
const MASTER_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const NUMBERS = [110, 111, 112, 113, 114, 115, 116, 117].map((n) => `+12025550${n}`);
const NUMBER_REFUSED = "This number can't be connected to this workspace.";

let cookieA: string;
let cookieB: string;
let orgA: string;
let orgB: string;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

function send(method: 'PUT' | 'DELETE', cookie: string, body?: unknown): Promise<Response> {
  return api('/api/v1/voice/connection', {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const connectBody = (callerIdE164: string, overrides: Record<string, unknown> = {}) => ({
  apiKey: API_KEY,
  connectionId: '1234567890',
  callerIdE164,
  ...overrides,
});

async function credentialRow(orgId: string): Promise<ProviderCredentialRow | undefined> {
  return withAdminDb(async (db) => {
    const [row] = await db
      .select()
      .from(providerCredential)
      .where(eq(providerCredential.organizationId, orgId));
    return row;
  });
}

async function routesOf(orgId: string): Promise<string[]> {
  return withAdminDb(async (db) =>
    (
      await db
        .select()
        .from(providerNumberRoute)
        .where(eq(providerNumberRoute.organizationId, orgId))
    ).map((r) => r.e164),
  );
}

beforeAll(async () => {
  await withAdminDb((db) =>
    db.delete(providerNumberRoute).where(inArray(providerNumberRoute.e164, NUMBERS)),
  );
  cookieA = await signUp(uniqueEmail('voice-a'));
  cookieB = await signUp(uniqueEmail('voice-b'));
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

describe('voice connection', () => {
  it('returns null before a connection exists', async () => {
    const r = await get('/api/v1/voice/connection', cookieB);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Connection>).data).toBeNull();
  });

  it('PUT then GET exposes only the last four characters', async () => {
    const put = await send('PUT', cookieA, connectBody(NUMBERS[0] as string));
    const putText = await put.text();
    expect(put.status).toBe(200);
    expect(putText).not.toContain(API_KEY);
    const got = await get('/api/v1/voice/connection', cookieA);
    const text = await got.text();
    expect(text).not.toContain(API_KEY);
    expect(text).not.toMatch(/ciphertext|dekWrapped/i);
    const body = JSON.parse(text) as Envelope<Connection>;
    expect(body.data).toMatchObject({
      provider: 'telnyx',
      apiKeyLast4: 'cdef',
      connectionId: '1234567890',
      callerIdE164: NUMBERS[0],
    });
  });

  it('stores ciphertext, not the key, and audits without the key', async () => {
    const row = await credentialRow(orgA);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(row?.apiKeyCiphertext).not.toBe(API_KEY);
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgA),
            eq(auditEvent.action, 'voice.connection.update'),
          ),
        ),
    );
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(API_KEY);
    expect(audits[0]?.metadata).toEqual({ last4: 'cdef' });
  });

  it('keeps tenants apart', async () => {
    expect(
      ((await (await get('/api/v1/voice/connection', cookieB)).json()) as Envelope<Connection>)
        .data,
    ).toBeNull();
    const del = await send('DELETE', cookieB);
    expect(del.status).toBe(204);
    const still = (await (
      await get('/api/v1/voice/connection', cookieA)
    ).json()) as Envelope<Connection>;
    expect(still.data?.apiKeyLast4).toBe('cdef');
    expect(await routesOf(orgA)).toEqual([NUMBERS[0]]);
  });

  it('rejects whitespace anywhere in the key', async () => {
    const r = await send(
      'PUT',
      cookieA,
      connectBody(NUMBERS[0] as string, { apiKey: `${API_KEY} x` }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('validation_error');
    const lead = await send(
      'PUT',
      cookieA,
      connectBody(NUMBERS[0] as string, { apiKey: ` ${API_KEY}` }),
    );
    expect(lead.status).toBe(400);
  });

  it('rejects an invalid caller id', async () => {
    const r = await send('PUT', cookieA, connectBody('not-a-number'));
    expect(r.status).toBe(400);
  });

  it('refuses a number routed to another workspace', async () => {
    const r = await send('PUT', cookieB, connectBody(NUMBERS[0] as string));
    expect(r.status).toBe(409);
    const body = (await r.json()) as Envelope<unknown>;
    // Generic copy: the response must not reveal that another customer holds the number.
    expect(body.error).toEqual({ code: 'validation_error', message: NUMBER_REFUSED });
    expect(await credentialRow(orgB)).toBeUndefined();
    expect(await routesOf(orgB)).toEqual([]);
  });

  it('in production stores the caller id but routes no inbound calls until the number is verified', async () => {
    const { app } = await import('../src/app');
    const { env } = await import('cloudflare:workers');
    const cookie = await signUp(uniqueEmail('voice-prod'));
    const orgId = await orgOf(cookie);
    const r = await app.request(
      '/api/v1/voice/connection',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(connectBody(NUMBERS[6] as string)),
      },
      { ...env, APP_ENV: 'production' } as unknown as Env,
      executionCtx,
    );
    expect(r.status).toBe(200);
    expect((await credentialRow(orgId))?.callerIdE164).toBe(NUMBERS[6]);
    expect(await routesOf(orgId)).toEqual([]);
  });

  it('makes concurrent first saves in one workspace idempotent', async () => {
    const cookie = await signUp(uniqueEmail('voice-race'));
    const orgId = await orgOf(cookie);
    const results = await Promise.all([
      send('PUT', cookie, connectBody(NUMBERS[7] as string)),
      send('PUT', cookie, connectBody(NUMBERS[7] as string)),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await withAdminDb((db) =>
      db.select().from(providerCredential).where(eq(providerCredential.organizationId, orgId)),
    );
    expect(rows).toHaveLength(1);
    expect(await routesOf(orgId)).toEqual([NUMBERS[7]]);
  });

  it('keeps the telephony credential when only the caller id changes, and moves the route', async () => {
    await withAdminDb((db) =>
      db
        .update(providerCredential)
        .set({ telephonyCredentialId: 'tc_existing' })
        .where(eq(providerCredential.organizationId, orgA)),
    );
    const r = await send('PUT', cookieA, connectBody(NUMBERS[1] as string));
    expect(r.status).toBe(200);
    expect((await credentialRow(orgA))?.telephonyCredentialId).toBe('tc_existing');
    expect(await routesOf(orgA)).toEqual([NUMBERS[1]]);
  });

  it('clears the telephony credential when the connection id changes', async () => {
    const r = await send(
      'PUT',
      cookieA,
      connectBody(NUMBERS[1] as string, { connectionId: '999' }),
    );
    expect(r.status).toBe(200);
    expect((await credentialRow(orgA))?.telephonyCredentialId).toBeNull();
  });

  it('clears the telephony credential when the key changes', async () => {
    await withAdminDb((db) =>
      db
        .update(providerCredential)
        .set({ telephonyCredentialId: 'tc_existing' })
        .where(eq(providerCredential.organizationId, orgA)),
    );
    const newKey = 'KEY0OTHERKEY1234567890wxyz';
    const r = await send(
      'PUT',
      cookieA,
      connectBody(NUMBERS[1] as string, { apiKey: newKey, connectionId: '999' }),
    );
    expect(r.status).toBe(200);
    expect((await credentialRow(orgA))?.telephonyCredentialId).toBeNull();
    expect(((await r.json()) as Envelope<Connection>).data?.apiKeyLast4).toBe('wxyz');
  });

  it('re-seals when the same key is submitted again', async () => {
    const before = await credentialRow(orgA);
    await send(
      'PUT',
      cookieA,
      connectBody(NUMBERS[1] as string, {
        apiKey: 'KEY0OTHERKEY1234567890wxyz',
        connectionId: '999',
      }),
    );
    const after = await credentialRow(orgA);
    expect(after?.apiKeyCiphertext).not.toBe(before?.apiKeyCiphertext);
  });

  it('denies a member role', async () => {
    const cookie = await signUp(uniqueEmail('voice-member'));
    const orgId = await orgOf(cookie);
    await withAdminDb((db) =>
      db.update(member).set({ role: 'member' }).where(eq(member.organizationId, orgId)),
    );
    const put = await send('PUT', cookie, connectBody(NUMBERS[2] as string));
    expect(put.status).toBe(403);
    expect(((await put.json()) as Envelope<unknown>).error?.code).toBe('forbidden');
    expect((await send('DELETE', cookie)).status).toBe(403);
    // Members may still read the connection and request a token.
    expect((await get('/api/v1/voice/connection', cookie)).status).toBe(200);
    expect((await post('/api/v1/voice/token', cookie, {})).status).toBe(200);
  });

  it('503s without a master key', async () => {
    const { app } = await import('../src/app');
    const { env } = await import('cloudflare:workers');
    const r = await app.request(
      '/api/v1/voice/connection',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: cookieA },
        body: JSON.stringify(connectBody(NUMBERS[3] as string)),
      },
      { ...env, CREDENTIALS_MASTER_KEY: undefined } as unknown as Env,
      executionCtx,
    );
    expect(r.status).toBe(503);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_configured');
  });

  it('deletes the connection and its number route', async () => {
    const cookie = await signUp(uniqueEmail('voice-del'));
    const orgId = await orgOf(cookie);
    expect((await send('PUT', cookie, connectBody(NUMBERS[4] as string))).status).toBe(200);
    expect((await send('DELETE', cookie)).status).toBe(204);
    expect(
      ((await (await get('/api/v1/voice/connection', cookie)).json()) as Envelope<Connection>).data,
    ).toBeNull();
    expect(await routesOf(orgId)).toEqual([]);
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgId),
            eq(auditEvent.action, 'voice.connection.delete'),
          ),
        ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ provider: 'telnyx' });
  });
});

type Status = { provider: 'fake' | 'telnyx' | 'none'; connected: boolean; last4: string | null };

async function statusWith(cookie: string, envOverrides: Partial<Env>): Promise<Response> {
  const { app } = await import('../src/app');
  const { env } = await import('cloudflare:workers');
  return app.request(
    '/api/v1/voice/status',
    { headers: { cookie } },
    { ...env, ...envOverrides } as unknown as Env,
    executionCtx,
  );
}

describe('voice status', () => {
  it('requires a session', async () => {
    expect((await get('/api/v1/voice/status')).status).toBe(401);
  });

  it('follows the connection through save and disconnect, and is never cached', async () => {
    const cookie = await signUp(uniqueEmail('voice-status'));
    const number = '+12025550118';
    await withAdminDb((db) =>
      db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, number)),
    );
    const before = await get('/api/v1/voice/status', cookie);
    expect(before.status).toBe(200);
    expect(before.headers.get('cache-control')).toBe('no-store');
    expect(((await before.json()) as Envelope<Status>).data).toEqual({
      provider: 'fake',
      connected: false,
      last4: null,
    });

    expect((await send('PUT', cookie, connectBody(number))).status).toBe(200);
    const saved = await get('/api/v1/voice/status', cookie);
    const savedText = await saved.text();
    expect(savedText).not.toContain(API_KEY);
    expect(savedText).not.toMatch(/ciphertext|dekWrapped|telephonyCredential/i);
    expect((JSON.parse(savedText) as Envelope<Status>).data).toEqual({
      provider: 'fake',
      connected: true,
      last4: 'cdef',
    });

    expect((await send('DELETE', cookie)).status).toBe(204);
    expect(
      ((await (await get('/api/v1/voice/status', cookie)).json()) as Envelope<Status>).data,
    ).toEqual({ provider: 'fake', connected: false, last4: null });
  });

  it('is telnyx when Telnyx is selected and the workspace is connected', async () => {
    const cookie = await signUp(uniqueEmail('voice-status-tx'));
    const number = '+12025550119';
    await withAdminDb((db) =>
      db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, number)),
    );
    expect((await send('PUT', cookie, connectBody(number))).status).toBe(200);
    const r = await statusWith(cookie, { PROVIDER: 'telnyx', APP_ENV: 'production' });
    expect(((await r.json()) as Envelope<Status>).data).toEqual({
      provider: 'telnyx',
      connected: true,
      last4: 'cdef',
    });
    await send('DELETE', cookie);
  });

  it('is none in production without a connection', async () => {
    const cookie = await signUp(uniqueEmail('voice-status-none'));
    const r = await statusWith(cookie, { PROVIDER: 'telnyx', APP_ENV: 'production' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(((await r.json()) as Envelope<Status>).data).toEqual({
      provider: 'none',
      connected: false,
      last4: null,
    });
  });

  it('shows each workspace only its own connection', async () => {
    // Saves its own key for A, so the result does not depend on the tests before it.
    const isolationKey = 'KEY0ISOLATIONONLY1234567890iso4';
    expect(
      (
        await send(
          'PUT',
          cookieA,
          connectBody(NUMBERS[1] as string, { apiKey: isolationKey, connectionId: '999' }),
        )
      ).status,
    ).toBe(200);
    const a = (await (await get('/api/v1/voice/status', cookieA)).json()) as Envelope<Status>;
    const b = (await (await get('/api/v1/voice/status', cookieB)).json()) as Envelope<Status>;
    expect(a.data).toEqual({ provider: 'fake', connected: true, last4: 'iso4' });
    expect(b.data).toEqual({ provider: 'fake', connected: false, last4: null });
  });

  it('is readable by a member', async () => {
    const cookie = await signUp(uniqueEmail('voice-status-member'));
    const orgId = await orgOf(cookie);
    await withAdminDb((db) =>
      db.update(member).set({ role: 'member' }).where(eq(member.organizationId, orgId)),
    );
    expect((await get('/api/v1/voice/status', cookie)).status).toBe(200);
  });
});

describe('voice token', () => {
  it('issues a fake token that is short-lived and not cacheable', async () => {
    const r = await post('/api/v1/voice/token', cookieB, {});
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as Envelope<{
      provider: string;
      token: string;
      expiresAt: string;
    }>;
    expect(body.data?.provider).toBe('fake');
    expect(body.data?.token).toBeTruthy();
    const ttl = Date.parse(body.data?.expiresAt ?? '') - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('requires a session', async () => {
    expect((await api('/api/v1/voice/token', { method: 'POST' })).status).toBe(401);
  });

  it('409s when no provider applies', async () => {
    const { app } = await import('../src/app');
    const { env } = await import('cloudflare:workers');
    const r = await app.request(
      '/api/v1/voice/token',
      { method: 'POST', headers: { cookie: cookieB } },
      { ...env, FAKE_WEBHOOK_SECRET: undefined } as unknown as Env,
      executionCtx,
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('voice_not_configured');
  });
});

describe('issueTelnyxToken', () => {
  async function connection(orgId: string): Promise<ProviderCredentialRow> {
    const row = await credentialRow(orgId);
    if (!row) throw new Error('no connection');
    return row;
  }

  it('persists a newly created telephony credential and returns the token', async () => {
    const cookie = await signUp(uniqueEmail('voice-tok'));
    const orgId = await orgOf(cookie);
    expect((await send('PUT', cookie, connectBody(NUMBERS[5] as string))).status).toBe(200);
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/telephony_credentials')) {
        return new Response(JSON.stringify({ data: { id: 'tc_new' } }), { status: 200 });
      }
      return new Response('jwt-token-value', { status: 200 });
    };
    const row = await connection(orgId);
    const result = await withAppDb((db) =>
      issueTelnyxToken(db, { orgId, userId: 'u', role: 'owner' }, row, MASTER_KEY, fetchImpl),
    );
    expect(result.provider).toBe('telnyx');
    expect(result.token).toBe('jwt-token-value');
    expect((await credentialRow(orgId))?.telephonyCredentialId).toBe('tc_new');
    // The second call reuses the stored credential.
    const row2 = await connection(orgId);
    calls.length = 0;
    await withAppDb((db) =>
      issueTelnyxToken(db, { orgId, userId: 'u', role: 'owner' }, row2, MASTER_KEY, fetchImpl),
    );
    expect(calls).toHaveLength(1);
  });

  it('maps a Telnyx failure to VoiceUpstreamError without the provider message', async () => {
    const cookie = await signUp(uniqueEmail('voice-tok2'));
    const orgId = await orgOf(cookie);
    const number = '+12025550116';
    await withAdminDb((db) =>
      db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, number)),
    );
    expect((await send('PUT', cookie, connectBody(number))).status).toBe(200);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ errors: [{ code: 'secret-detail', title: API_KEY }] }), {
        status: 401,
      });
    const row = await connection(orgId);
    const error = await withAppDb((db) =>
      issueTelnyxToken(db, { orgId, userId: 'u', role: 'owner' }, row, MASTER_KEY, fetchImpl),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(VoiceUpstreamError);
    expect((error as Error).message).not.toContain(API_KEY);
    await withAdminDb((db) =>
      db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, number)),
    );
  });
});

describe('selectVoiceProvider', () => {
  const conn = { id: 'pc_x', provider: 'telnyx' } as ProviderCredentialRow;
  const plivo = { id: 'pc_y', provider: 'plivo' } as ProviderCredentialRow;
  const env = (over: Partial<Env>): Pick<Env, 'PROVIDER' | 'APP_ENV' | 'FAKE_WEBHOOK_SECRET'> => ({
    APP_ENV: 'test',
    ...over,
  });
  const cases: Array<[string, Partial<Env>, ProviderCredentialRow | null, string]> = [
    ['telnyx with connection', { PROVIDER: 'telnyx' }, conn, 'telnyx'],
    ['connectors with a Telnyx connection', { PROVIDER: 'connectors' }, conn, 'telnyx'],
    ['connectors with a Plivo connection', { PROVIDER: 'connectors' }, plivo, 'plivo'],
    ['the older telnyx value with a Plivo connection', { PROVIDER: 'telnyx' }, plivo, 'plivo'],
    [
      'telnyx in production with connection',
      { PROVIDER: 'telnyx', APP_ENV: 'production' },
      conn,
      'telnyx',
    ],
    [
      'telnyx without connection falls back to fake',
      { PROVIDER: 'telnyx', FAKE_WEBHOOK_SECRET: 's' },
      null,
      'fake',
    ],
    ['telnyx without connection and no fake secret', { PROVIDER: 'telnyx' }, null, 'none'],
    ['default provider with fake secret', { FAKE_WEBHOOK_SECRET: 's' }, null, 'fake'],
    [
      'fake provider ignores a connection',
      { PROVIDER: 'fake', FAKE_WEBHOOK_SECRET: 's' },
      conn,
      'fake',
    ],
    ['no fake secret', {}, null, 'none'],
    [
      'production, fake provider',
      { PROVIDER: 'fake', APP_ENV: 'production', FAKE_WEBHOOK_SECRET: 's' },
      conn,
      'none',
    ],
    [
      'production, nothing configured',
      { APP_ENV: 'production', FAKE_WEBHOOK_SECRET: 's' },
      null,
      'none',
    ],
  ];
  it.each(cases)('%s', (_name, over, connectionRow, kind) => {
    expect(selectVoiceProvider(env(over), connectionRow).kind).toBe(kind);
  });
});

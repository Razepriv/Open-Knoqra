import { createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  createDb,
  type Database,
  member,
  type NewPhoneNumber,
  phoneNumber,
  providerCredential,
  session,
  withTenant,
} from '@knoqra/db';
import type { NumberPurchaseProvider } from '@knoqra/providers';
import { eq } from 'drizzle-orm';
import type { Env } from '../src/env';
import { requestAuth } from '../src/lib/auth-context';
import type { AppEnv } from '../src/lib/context';
import { requestDb } from '../src/lib/db';
import { lastFour, sealSecret, telnyxKeyAad } from '../src/lib/secret-envelope';
import { tenant } from '../src/middleware/tenant';
import { messagingSendersRoutes } from '../src/routes/messaging-senders';

export const BASE = 'http://localhost:8787';
export const PASSWORD = 'correct-horse-battery-staple';

/** A fresh address per call, so re-running the suite against the same database never collides. */
export function uniqueEmail(local: string): string {
  return `${local}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init);
}

/** Folds Set-Cookie headers into one Cookie request header. */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export function authPost(path: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(body),
  });
}

/** Signs up through Better Auth and returns the session cookie header. */
export async function signUp(email: string, name = 'Test User'): Promise<string> {
  const r = await authPost('/api/auth/sign-up/email', { email, password: PASSWORD, name });
  if (r.status !== 200) throw new Error(`sign-up failed: ${r.status} ${await r.text()}`);
  return cookieHeader(r);
}

export async function signIn(email: string): Promise<string> {
  const r = await authPost('/api/auth/sign-in/email', { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  return cookieHeader(r);
}

export function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

export function get(path: string, cookie?: string): Promise<Response> {
  return api(path, cookie ? { headers: { cookie } } : undefined);
}

async function withDb<T>(url: string | undefined, fn: (db: Database) => Promise<T>): Promise<T> {
  if (!url) throw new Error('database URL test binding is missing');
  const handle = createDb(url);
  try {
    return await fn(handle.db);
  } finally {
    await handle.close();
  }
}

/**
 * Runs `fn` on a short-lived connection as the app role (knoqra_app, subject to RLS).
 * Opened and closed per call: Workers I/O objects must not outlive the context that made them.
 */
export function withAppDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return withDb(env.DATABASE_URL, fn);
}

/** Admin role, for test fixtures the app role cannot (or should not) change. */
export function withAdminDb<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return withDb(env.MIGRATION_DATABASE_URL, fn);
}

/** A purchase port for stubbed provider access that must never be used. */
export const NO_PURCHASE: NumberPurchaseProvider = {
  searchAvailableNumbers: async () => [],
  quoteNumber: async () => null,
  orderNumber: async () => {
    throw new Error('orderNumber is not expected in this test');
  },
};

/**
 * Signs up another user and makes them a plain member of `orgId`, with their session switched to
 * it: a teammate in the same organization, for same-org, other-user isolation tests.
 */
export async function signUpTeammate(orgId: string): Promise<{ cookie: string; userId: string }> {
  const cookie = await signUp(uniqueEmail('mate'), 'Teammate');
  const me = (await (await get('/api/v1/me', cookie)).json()) as { data: { user: { id: string } } };
  const userId = me.data.user.id;
  await withAdminDb(async (db) => {
    await db.insert(member).values({
      id: `m-${crypto.randomUUID()}`,
      organizationId: orgId,
      userId,
      createdAt: new Date(),
    });
    await db.update(session).set({ activeOrganizationId: orgId }).where(eq(session.userId, userId));
  });
  return { cookie, userId };
}

/** A test-only Telnyx API key. Never a real key. */
export const TEST_TELNYX_API_KEY = 'KEY0TESTONLY1234567890abcdef';

/**
 * Saves a Telnyx credential for `orgId` straight into the vault, sealed with the test master key,
 * without the voice route's number routing (so tests choose their own numbers freely).
 */
export async function saveTelnyxCredential(
  orgId: string,
  callerIdE164: string | null,
  apiKey: string = TEST_TELNYX_API_KEY,
): Promise<void> {
  const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
  if (!masterKeyBase64) throw new Error('CREDENTIALS_MASTER_KEY test binding is missing');
  const sealed = await sealSecret(apiKey, { masterKeyBase64, aad: telnyxKeyAad(orgId) });
  await withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx.insert(providerCredential).values({
        organizationId: orgId,
        provider: 'telnyx',
        apiKeyCiphertext: sealed.ciphertext,
        apiKeyIv: sealed.iv,
        dekWrapped: sealed.dekWrapped,
        dekIv: sealed.dekIv,
        keyFingerprint: sealed.keyFingerprint,
        apiKeyLast4: lastFour(apiKey),
        connectionId: '1234567890',
        callerIdE164,
      }),
    ),
  );
}

/**
 * A number as M4's sync leaves it in the org's `phone_number` table: by default an active Telnyx
 * number that can send SMS and WhatsApp, 10DLC registered and Meta approved. Written through the
 * app role under RLS, as the sync writes it.
 */
export async function seedSyncedNumber(
  orgId: string,
  e164: string,
  overrides: Partial<NewPhoneNumber> = {},
): Promise<void> {
  await withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx.insert(phoneNumber).values({
        organizationId: orgId,
        provider: 'telnyx',
        providerNumberId: `tn-${e164.slice(1)}`,
        e164,
        status: 'active',
        voice: true,
        sms: true,
        mms: true,
        whatsapp: true,
        tenDlcStatus: 'registered',
        whatsappStatus: 'approved',
        lastSyncedAt: new Date(),
        ...overrides,
      }),
    ),
  );
}

/**
 * A Telnyx `GET /v2/phone_numbers?filter[phone_number]=…` stand-in (no network in tests). A number
 * in `owned` is listed, shaped like the providers fixture `list-phone-numbers-owned.json`; any
 * other number gets an empty listing. `status` other than 200 answers Telnyx's error body instead.
 */
export function phoneNumbersFetch(owned: Iterable<string>, status = 200) {
  const numbers = new Set(owned);
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (status !== 200) {
      return Response.json(
        { errors: [{ code: '10009', title: 'Authentication failed' }] },
        { status },
      );
    }
    const e164 = `+${url.searchParams.get('filter[phone_number]') ?? ''}`;
    const data = numbers.has(e164)
      ? [
          {
            id: '1293384261075731499',
            record_type: 'phone_number',
            phone_number: e164,
            status: 'active',
          },
        ]
      : [];
    const meta = {
      total_pages: data.length,
      total_results: data.length,
      page_number: 1,
      page_size: 25,
    };
    return Response.json({ data, meta });
  }) as typeof fetch;
  return { impl, calls };
}

/**
 * The messaging senders routes behind the real session chain, with `fetchImpl` as the Telnyx
 * fetch of the ownership check. Requests run with `bindings` and a real execution context
 * (requestDb closes its connection in waitUntil).
 */
export async function sendersRequest(
  fetchImpl: typeof fetch,
  bindings: Env,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  app.use('/api/v1/*', requestDb, requestAuth, tenant());
  app.route('/', messagingSendersRoutes({ fetch: fetchImpl }));
  const ctx = createExecutionContext();
  const response = await app.request(path, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

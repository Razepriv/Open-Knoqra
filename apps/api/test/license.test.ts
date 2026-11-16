import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { OpenAPIHono } from '@hono/zod-openapi';
import { encodeLicense, type LicensePayload } from '@knoqra/core';
import { instanceLicense } from '@knoqra/db';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { requestAuth } from '../src/lib/auth-context';
import type { AppEnv } from '../src/lib/context';
import { requestDb } from '../src/lib/db';
import { createLicenseChecker, type LicenseChecker } from '../src/license/status';
import { tenant } from '../src/middleware/tenant';
import { licenseGate, licenseRoutes } from '../src/routes/license';
import { walletRoutes } from '../src/routes/wallet';
import { get, signUp, signUpTeammate, uniqueEmail, withAdminDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Status = {
  edition: string;
  required: boolean;
  licensed: boolean;
  source: string | null;
  license: { login: string; githubId: string; issuedAt: string } | null;
  reason: string | null;
  message: string | null;
};
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const toB64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** A fresh test-only Ed25519 pair: the signing secret's text and the public key to embed. */
async function testKeys(): Promise<{ privateKey: Key; publicB64: string; pkcs8B64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
    privateKey: Key;
    publicKey: Key;
  };
  return {
    privateKey: pair.privateKey,
    publicB64: toB64((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    pkcs8B64: toB64((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer),
  };
}

const KEYS = await testKeys();
const OTHER_KEYS = await testKeys();
const TODAY = new Date();
const payload = (over: Partial<LicensePayload> = {}): LicensePayload => ({
  v: 1,
  sub: '583231',
  login: 'octocat',
  iat: TODAY.toISOString().slice(0, 10),
  edition: 'selfhost',
  ...over,
});

const SELFHOST = { KNOQRA_EDITION: 'selfhost' } as const;

beforeEach(async () => {
  await withAdminDb((db) => db.delete(instanceLicense));
});

async function newOrg(label: string): Promise<{ cookie: string; orgId: string }> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

/** The session chain, the license gate and routes, and the wallet as an example gated route. */
async function desk(
  checker: LicenseChecker,
  path: string,
  init: RequestInit,
  overrides: Partial<Env> = SELFHOST,
): Promise<Response> {
  const app = new OpenAPIHono<AppEnv>();
  app.use('/api/v1/*', requestDb, requestAuth, tenant());
  app.use('/api/v1/*', licenseGate(checker));
  app.route('/', licenseRoutes(checker));
  app.route('/', walletRoutes);
  app.get('/api/v1/me', (c) => c.json({ ok: true }));
  const ctx = createExecutionContext();
  const response = await app.request(path, init, { ...env, ...overrides } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const putKey = (cookie: string, key: string): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ key }),
});

async function statusOf(
  checker: LicenseChecker,
  cookie: string,
  overrides: Partial<Env> = SELFHOST,
) {
  const response = await desk(checker, '/api/v1/license', { headers: { cookie } }, overrides);
  expect(response.status).toBe(200);
  return ((await response.json()) as Envelope<Status>).data;
}

describe('the self-host license gate', () => {
  it('locks /api/v1 until a valid key is entered, leaving me and license open', async () => {
    const checker = createLicenseChecker(KEYS.publicB64);
    const { cookie } = await newOrg('gate');
    const locked = await desk(checker, '/api/v1/wallet', { headers: { cookie } });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as Envelope<unknown>).error?.code).toBe('license_required');
    expect((await desk(checker, '/api/v1/me', { headers: { cookie } })).status).toBe(200);
    expect(await statusOf(checker, cookie)).toMatchObject({
      edition: 'selfhost',
      required: true,
      licensed: false,
      reason: 'missing',
    });

    const key = await encodeLicense(payload(), KEYS.privateKey);
    const saved = await desk(checker, '/api/v1/license', putKey(cookie, `${key}\n`));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Envelope<Status>).data).toMatchObject({
      licensed: true,
      source: 'stored',
      license: { login: 'octocat', githubId: '583231' },
      reason: null,
    });
    expect((await desk(checker, '/api/v1/wallet', { headers: { cookie } })).status).toBe(200);

    // Another isolate (a fresh checker) reads the stored key from Postgres.
    const elsewhere = createLicenseChecker(KEYS.publicB64);
    expect((await desk(elsewhere, '/api/v1/wallet', { headers: { cookie } })).status).toBe(200);
  });

  it('refuses keys that do not verify, with the reason, and stores nothing', async () => {
    const checker = createLicenseChecker(KEYS.publicB64);
    const { cookie } = await newOrg('gate-bad');
    const foreign = await encodeLicense(payload(), OTHER_KEYS.privateKey);
    for (const [key, message] of [
      [foreign, /not issued by KNOQRA/],
      ['KNOQRA-LICENSE-1.nope.nope', /not a KNOQRA license key/],
      ['hello', /not a KNOQRA license key/],
    ] as const) {
      const response = await desk(checker, '/api/v1/license', putKey(cookie, key));
      expect(response.status).toBe(400);
      const body = (await response.json()) as Envelope<unknown>;
      expect(body.error?.code).toBe('license_invalid');
      expect(body.error?.message).toMatch(message);
    }
    expect(await withAdminDb((db) => db.select().from(instanceLicense))).toHaveLength(0);
  });

  it('lets only owners and admins enter the key', async () => {
    const checker = createLicenseChecker(KEYS.publicB64);
    const { orgId } = await newOrg('gate-role');
    const mate = await signUpTeammate(orgId);
    const key = await encodeLicense(payload(), KEYS.privateKey);
    const response = await desk(checker, '/api/v1/license', putKey(mate.cookie, key));
    expect(response.status).toBe(403);
  });

  it('accepts the key from KNOQRA_LICENSE_KEY instead of the Desk', async () => {
    const { cookie } = await newOrg('gate-env');
    const key = await encodeLicense(payload({ login: 'env-user' }), KEYS.privateKey);
    const withEnv = { ...SELFHOST, KNOQRA_LICENSE_KEY: key };
    const status = await statusOf(createLicenseChecker(KEYS.publicB64), cookie, withEnv);
    expect(status).toMatchObject({ licensed: true, source: 'env', license: { login: 'env-user' } });
    const bad = { ...SELFHOST, KNOQRA_LICENSE_KEY: 'garbage' };
    expect(await statusOf(createLicenseChecker(KEYS.publicB64), cookie, bad)).toMatchObject({
      licensed: false,
      reason: 'malformed',
    });
  });

  it('fails closed when the build has no public key embedded', async () => {
    const checker = createLicenseChecker('');
    const { cookie } = await newOrg('gate-nokey');
    const key = await encodeLicense(payload(), KEYS.privateKey);
    const response = await desk(checker, '/api/v1/license', putKey(cookie, key));
    expect(response.status).toBe(400);
    expect(((await response.json()) as Envelope<unknown>).error?.message).toMatch(
      /no license public key/,
    );
    expect((await desk(checker, '/api/v1/wallet', { headers: { cookie } })).status).toBe(403);
  });

  it('never runs on cloud', async () => {
    const checker = createLicenseChecker('');
    const { cookie } = await newOrg('gate-cloud');
    const cloud = { KNOQRA_EDITION: 'cloud' };
    expect((await desk(checker, '/api/v1/wallet', { headers: { cookie } }, cloud)).status).toBe(
      200,
    );
    expect(await statusOf(checker, cookie, cloud)).toMatchObject({
      edition: 'cloud',
      required: false,
      reason: null,
    });
    const key = await encodeLicense(payload(), KEYS.privateKey);
    expect((await desk(checker, '/api/v1/license', putKey(cookie, key), cloud)).status).toBe(404);
  });

  it('the full app runs as cloud in tests and serves /api/v1/license', async () => {
    const { cookie } = await newOrg('gate-full');
    const response = await get('/api/v1/license', cookie);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Envelope<Status>).data).toMatchObject({
      edition: 'cloud',
      required: false,
    });
  });
});

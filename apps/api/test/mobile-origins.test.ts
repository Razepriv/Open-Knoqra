import { env } from 'cloudflare:workers';
import type { Database } from '@knoqra/db';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { assertSafeAuthConfig, createAuth, trustedOriginsFor } from '../src/auth/auth';
import type { Env } from '../src/env';
import { PASSWORD, signUp, uniqueEmail } from './helpers';

/*
 * `SELF.fetch` runs the Worker with its own bindings (APP_ENV=test), so origin checks that depend
 * on APP_ENV call the app directly with an env override, like the webhook tests do.
 */

function randomIp(): string {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface SignInOptions {
  appEnv?: Env['APP_ENV'];
  baseUrl?: string;
  /** Headers added to the request. Default: a fresh cf-connecting-ip, so the limiter stays idle. */
  headers?: Record<string, string>;
  password?: string;
}

async function signInFrom(
  origin: string,
  email: string,
  appEnvOrOptions: Env['APP_ENV'] | SignInOptions = 'test',
): Promise<Response> {
  const options: SignInOptions =
    typeof appEnvOrOptions === 'string' ? { appEnv: appEnvOrOptions } : appEnvOrOptions;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const response = await app.request(
    '/api/auth/sign-in/email',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        // Better Auth keys its rate limit on this header (see createAuth). A fresh address per
        // call keeps its deployed-env limiter out of the way. The durable RL_AUTH binding is
        // absent from the test env (see rate-limit.test.ts).
        'cf-connecting-ip': randomIp(),
        ...options.headers,
      },
      body: JSON.stringify({ email, password: options.password ?? PASSWORD }),
    },
    {
      ...env,
      APP_ENV: options.appEnv ?? 'test',
      ...(options.baseUrl ? { BETTER_AUTH_URL: options.baseUrl } : {}),
    } as unknown as Env,
    executionCtx,
  );
  await Promise.allSettled(pending);
  return response;
}

describe('mobile sign-in origins', () => {
  it('accepts the app scheme origin knoqra://', async () => {
    const email = uniqueEmail('mob');
    await signUp(email, 'Mobile User');
    expect((await signInFrom('knoqra://', email)).status).toBe(200);
  });

  it('accepts an app deep-link origin with a host and path', async () => {
    const email = uniqueEmail('mobp');
    await signUp(email, 'Mobile Path');
    expect((await signInFrom('knoqra://auth/callback', email)).status).toBe(200);
  });

  it('rejects an arbitrary web origin in every environment', async () => {
    const email = uniqueEmail('evil');
    await signUp(email, 'Evil Origin');
    for (const appEnv of ['test', 'development', 'production'] as const) {
      expect((await signInFrom('https://evil.example', email, appEnv)).status).toBe(403);
    }
  });

  it('rejects a look-alike scheme', async () => {
    const email = uniqueEmail('like');
    await signUp(email, 'Look Alike');
    expect((await signInFrom('knoqra-evil://', email)).status).toBe(403);
    expect((await signInFrom('knoqra.evil://x', email)).status).toBe(403);
  });

  it.each(['exp://', 'exp://192.168.1.20:8081', 'exp://192.168.1.20:8081/--/auth'])(
    'rejects %s outside development',
    async (origin) => {
      const email = uniqueEmail('exp');
      await signUp(email, 'Expo Blocked');
      for (const appEnv of ['test', 'staging', 'production'] as const) {
        expect((await signInFrom(origin, email, appEnv)).status).toBe(403);
      }
    },
  );

  it.each(['exp://', 'exp://192.168.1.20:8081', 'exp://192.168.1.20:8081/--/auth'])(
    'accepts %s in development',
    async (origin) => {
      const email = uniqueEmail('expd');
      await signUp(email, 'Expo Dev');
      expect((await signInFrom(origin, email, 'development')).status).toBe(200);
    },
  );

  it('lists exp:// patterns only in development', () => {
    const base = { BETTER_AUTH_URL: 'http://localhost:5173' };
    const always = ['http://localhost:5173', 'knoqra://', 'knoqra://*'];
    for (const appEnv of ['test', 'staging', 'production'] as const) {
      expect(trustedOriginsFor({ ...base, APP_ENV: appEnv })).toEqual(always);
    }
    expect(trustedOriginsFor({ ...base, APP_ENV: 'development' })).toEqual([
      ...always,
      'exp://',
      'exp://**',
      'exp://192.168.*.*:*/**',
    ]);
  });
});

describe('exp:// trust needs a local base URL', () => {
  it('rejects exp:// in development when BETTER_AUTH_URL is a deployed host', async () => {
    const email = uniqueEmail('expdep');
    await signUp(email, 'Expo Deployed');
    const r = await signInFrom('exp://192.168.1.20:8081', email, {
      appEnv: 'development',
      baseUrl: 'https://app.knoqra.dev',
    });
    expect(r.status).toBe(403);
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'accepts exp:// in development with BETTER_AUTH_URL %s',
    async (baseUrl) => {
      const email = uniqueEmail('explocal');
      await signUp(email, 'Expo Local');
      const r = await signInFrom('exp://192.168.1.20:8081', email, {
        appEnv: 'development',
        baseUrl,
      });
      expect(r.status).toBe(200);
    },
  );

  it('only lists exp:// for development on a local base URL', () => {
    const exp = (url: string, appEnv: Env['APP_ENV']) =>
      trustedOriginsFor({ BETTER_AUTH_URL: url, APP_ENV: appEnv }).includes('exp://');
    expect(exp('https://app.knoqra.dev', 'development')).toBe(false);
    expect(exp('not a url', 'development')).toBe(false);
    expect(exp('http://localhost:5173', 'development')).toBe(true);
    expect(exp('http://localhost:5173', 'production')).toBe(false);
  });
});

describe('rate limiter client address', () => {
  async function attempts(count: number, headersAt: (i: number) => Record<string, string>) {
    const email = uniqueEmail('rl');
    await signUp(email, 'Rate Limited');
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      const r = await signInFrom('knoqra://', email, {
        appEnv: 'production',
        password: 'definitely-the-wrong-password',
        headers: headersAt(i),
      });
      statuses.push(r.status);
    }
    return statuses;
  }

  it('rotating x-forwarded-for does not evade the limiter in a deployed env', async () => {
    const cf = randomIp();
    const statuses = await attempts(6, () => ({
      'cf-connecting-ip': cf,
      'x-forwarded-for': randomIp(),
    }));
    expect(statuses).toContain(429);
  });

  it('rotating cf-connecting-ip does (Cloudflare overwrites that header)', async () => {
    const statuses = await attempts(6, () => ({ 'cf-connecting-ip': randomIp() }));
    expect(statuses).not.toContain(429);
  });
});

describe('configuration guard for the Expo plugin', () => {
  const LOCAL = 'http://localhost:5173';
  const DEPLOYED = 'https://app.knoqra.dev';

  it.each([
    ['staging', LOCAL],
    ['production', LOCAL],
    ['production', DEPLOYED],
    ['development', DEPLOYED],
    ['test', DEPLOYED],
  ] as const)('throws with NODE_ENV=development, APP_ENV=%s, BETTER_AUTH_URL=%s', (appEnv, url) => {
    expect(() =>
      assertSafeAuthConfig({ APP_ENV: appEnv, BETTER_AUTH_URL: url }, 'development'),
    ).toThrow(/@better-auth\/expo trust exp:\/\//);
  });

  it.each([
    ['development', LOCAL, 'development'],
    ['test', LOCAL, 'development'],
    ['production', DEPLOYED, 'production'],
    ['development', DEPLOYED, 'production'],
    ['staging', DEPLOYED, undefined],
    ['development', DEPLOYED, undefined],
  ] as const)('allows APP_ENV=%s, BETTER_AUTH_URL=%s, NODE_ENV=%s', (appEnv, url, nodeEnv) => {
    expect(() =>
      assertSafeAuthConfig({ APP_ENV: appEnv, BETTER_AUTH_URL: url }, nodeEnv),
    ).not.toThrow();
  });

  it('createAuth itself fails closed on a development NODE_ENV with a deployed base URL', () => {
    const build = (appEnv: Env['APP_ENV'], baseUrl: string) =>
      createAuth(
        { ...env, APP_ENV: appEnv, BETTER_AUTH_URL: baseUrl } as unknown as Env,
        {} as Database,
      );
    vi.stubEnv('NODE_ENV', 'development');
    try {
      expect(() => build('development', DEPLOYED)).toThrow(/Auth misconfiguration/);
      expect(() => build('production', LOCAL)).toThrow(/Auth misconfiguration/);
      expect(() => build('development', LOCAL)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() => build('development', DEPLOYED)).not.toThrow();
  });
});

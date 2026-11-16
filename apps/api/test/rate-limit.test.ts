import { env } from 'cloudflare:workers';
import { call, ledgerEntry, withTenant } from '@knoqra/db';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { addressGroup, clientIp } from '../src/lib/rate-limit';
import { api, BASE, get, post, signUp, signUpTeammate, uniqueEmail, withAppDb } from './helpers';

/*
 * The durable limits are Workers Rate Limiting bindings. The test pool has none (wrangler.jsonc
 * declares them only in the staging and production blocks), so each test passes fake bindings
 * through `app.request(path, init, env, executionCtx)`. A fake counts per key in a Map it closes
 * over: sharing one fake across env objects stands in for two isolates hitting one namespace.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type User = { cookie: string; orgId: string; userId: string };
type RateLimitBindings = Partial<
  Pick<Env, 'RL_AUTH' | 'RL_DIAL' | 'RL_VOICE_TOKEN' | 'RL_MESSAGE_SEND'>
>;

const LIMITED_MESSAGE = 'Too many requests. Wait a minute and try again.';
const PHONE = '+12025550131';

interface FakeLimiter {
  binding: RateLimit;
  keys: string[];
}

function fakeLimiter(limit: number): FakeLimiter {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }) => {
        keys.push(key);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= limit };
      },
    },
  };
}

const brokenLimiter: RateLimit = {
  limit: async () => {
    throw new Error('rate limiter unavailable');
  },
};

function envWith(bindings: RateLimitBindings): Env {
  return { ...env, ...bindings } as unknown as Env;
}

interface Sent {
  response: Response;
  /** waitUntil calls the request made: requestDb registers one to close its connection. */
  backgroundTasks: number;
}

async function send(path: string, init: RequestInit, targetEnv: Env): Promise<Sent> {
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const response = await app.request(path, init, targetEnv, executionCtx);
  await Promise.allSettled(pending);
  return { response, backgroundTasks: pending.length };
}

function authInit(ip: string | undefined, body: unknown, extra: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
      ...(ip === undefined ? {} : { 'cf-connecting-ip': ip }),
      ...extra,
    },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

function userInit(cookie: string, body: unknown = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

const wrongSignIn = { email: 'nobody-rate-limit@example.test', password: 'not-the-password-12' };

async function expectLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  const body = (await response.json()) as Envelope<unknown>;
  expect(body).toEqual({ data: null, error: { code: 'rate_limited', message: LIMITED_MESSAGE } });
}

async function newUser(label: string): Promise<User> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  return { cookie, orgId, userId };
}

let logs: string[] = [];

beforeAll(() => {
  expect(env.RL_AUTH).toBeUndefined();
});

afterEach(() => {
  vi.restoreAllMocks();
  logs = [];
});

function captureLogs(): void {
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
}

describe('clientIp', () => {
  it.each([
    [{ 'cf-connecting-ip': '198.51.100.7' }, '198.51.100.7'],
    [{ 'cf-connecting-ip': '2001:db8::1' }, '2001:db8::1'],
    [{}, 'unknown'],
    [{ 'x-forwarded-for': '198.51.100.8' }, 'unknown'],
    [{ 'x-real-ip': '198.51.100.9', 'true-client-ip': '198.51.100.10' }, 'unknown'],
    [{ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.8' }, '198.51.100.7'],
  ])('reads %j as %s', (headers, ip) => {
    expect(clientIp(new Headers(headers))).toBe(ip);
  });
});

describe('addressGroup', () => {
  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['unknown', 'unknown'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['[2001:db8:1:2::1]', '2001:db8:1:2::/64'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['::ffff:c633:6407', '198.51.100.7'],
    ['64:ff9b::198.51.100.7', '64:ff9b:0:0::/64'],
    ['2001:db8::1::2', '2001:db8::1::2'],
    ['2001:db8:1:2:3:4:5:6:7', '2001:db8:1:2:3:4:5:6:7'],
    ['2001:DB8:zz::1', '2001:db8:zz::1'],
    ['::ffff:300.1.1.1', '::ffff:300.1.1.1'],
  ])('groups %s as %s', (ip, group) => {
    expect(addressGroup(ip)).toBe(group);
  });
});

describe('auth rate limit', () => {
  it('allows 10 sign-ins from one cf-connecting-ip and limits the 11th, before any database work', async () => {
    captureLogs();
    const limiter = fakeLimiter(10);
    const target = envWith({ RL_AUTH: limiter.binding });
    const ip = '198.51.100.21';
    for (let i = 0; i < 10; i += 1) {
      const allowed = await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target);
      expect(allowed.response.status).not.toBe(429);
      // Positive control: an allowed attempt opens the request's database handle.
      expect(allowed.backgroundTasks).toBeGreaterThanOrEqual(1);
    }
    const eleventh = await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target);
    await expectLimited(eleventh.response);
    expect(eleventh.backgroundTasks).toBe(0);
    expect(limiter.keys[0]).toBe(`auth:sign-in/email:${ip}`);

    const hit = logs.filter((line) => line.includes('rate_limit.hit'));
    expect(hit).toHaveLength(1);
    expect(JSON.parse(hit[0] ?? '{}')).toMatchObject({
      level: 'warn',
      rule: 'auth',
      route: '/api/auth/sign-in/email',
    });
    expect(hit[0]).not.toContain(ip);
    expect(hit[0]).not.toContain('auth:sign-in');
  });

  it('ignores x-forwarded-for: varying it does not reset the count', async () => {
    const target = envWith({ RL_AUTH: fakeLimiter(10).binding });
    const ip = '198.51.100.22';
    for (let i = 0; i < 10; i += 1) {
      const init = authInit(ip, wrongSignIn, { 'x-forwarded-for': `192.0.2.${i + 1}` });
      expect((await send('/api/auth/sign-in/email', init, target)).response.status).not.toBe(429);
    }
    const init = authInit(ip, wrongSignIn, { 'x-forwarded-for': '192.0.2.99' });
    await expectLimited((await send('/api/auth/sign-in/email', init, target)).response);
  });

  it('counts an IPv6 /64 together, whatever the spelling, and not another /64', async () => {
    const limiter = fakeLimiter(10);
    const target = envWith({ RL_AUTH: limiter.binding });
    const spellings = [
      '2001:db8:1:2::1',
      '2001:db8:1:2:0:0:0:1',
      '2001:0db8:0001:0002:0000:0000:0000:0001',
      '2001:db8:1:2:ffff:1:2:3',
    ];
    for (let i = 0; i < 10; i += 1) {
      const init = authInit(spellings[i % spellings.length], wrongSignIn);
      expect((await send('/api/auth/sign-in/email', init, target)).response.status).not.toBe(429);
    }
    const sameSubnet = authInit('2001:db8:1:2:abcd::9', wrongSignIn);
    await expectLimited((await send('/api/auth/sign-in/email', sameSubnet, target)).response);
    expect(new Set(limiter.keys)).toEqual(new Set(['auth:sign-in/email:2001:db8:1:2::/64']));

    const otherSubnet = authInit('2001:db8:1:3::1', wrongSignIn);
    const other = await send('/api/auth/sign-in/email', otherSubnet, target);
    expect(other.response.status).not.toBe(429);
  });

  it('counts per address: another cf-connecting-ip is not limited', async () => {
    const target = envWith({ RL_AUTH: fakeLimiter(10).binding });
    for (let i = 0; i < 11; i += 1) {
      await send('/api/auth/sign-in/email', authInit('198.51.100.23', wrongSignIn), target);
    }
    const other = await send(
      '/api/auth/sign-in/email',
      authInit('198.51.100.24', wrongSignIn),
      target,
    );
    expect(other.response.status).not.toBe(429);
  });

  it('counts across isolates: two env objects sharing one namespace count together', async () => {
    const shared = fakeLimiter(10);
    const first = envWith({ RL_AUTH: shared.binding });
    const second = envWith({ RL_AUTH: shared.binding });
    const ip = '198.51.100.25';
    for (let i = 0; i < 10; i += 1) {
      const target = i % 2 === 0 ? first : second;
      expect(
        (await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target)).response.status,
      ).not.toBe(429);
    }
    await expectLimited(
      (await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), second)).response,
    );
  });

  it.each([
    ['/api/auth/sign-up/email', 'sign-up/email'],
    ['/api/auth/request-password-reset', 'request-password-reset'],
    ['/api/auth/reset-password', 'reset-password'],
    ['/api/auth/two-factor/verify-totp', 'two-factor/verify-totp'],
    ['/api/auth/two-factor/verify-backup-code', 'two-factor/verify-backup-code'],
    ['/api/auth/two-factor/verify-otp', 'two-factor/verify-otp'],
  ])('limits %s at the 11th attempt', async (path, route) => {
    const limiter = fakeLimiter(10);
    const target = envWith({ RL_AUTH: limiter.binding });
    const ip = '198.51.100.26';
    for (let i = 0; i < 10; i += 1) {
      expect((await send(path, authInit(ip, {}), target)).response.status).not.toBe(429);
    }
    await expectLimited((await send(path, authInit(ip, {}), target)).response);
    expect(new Set(limiter.keys)).toEqual(new Set([`auth:${route}:${ip}`]));
  });

  it('keeps separate counts per route for one address', async () => {
    const target = envWith({ RL_AUTH: fakeLimiter(10).binding });
    const ip = '198.51.100.27';
    for (let i = 0; i < 11; i += 1) {
      await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target);
    }
    const reset = await send('/api/auth/request-password-reset', authInit(ip, {}), target);
    expect(reset.response.status).not.toBe(429);
  });

  it('leaves no unlimited spelling of a limited path', async () => {
    const target = envWith({ RL_AUTH: fakeLimiter(10).binding });
    const ip = '198.51.100.28';
    for (let i = 0; i < 10; i += 1) {
      await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target);
    }
    // Better Auth answers these spellings with 404, so they cannot be used to dodge the limit.
    for (const path of [
      '/api/auth/sign-in/email/',
      '/api/auth//sign-in/email',
      '/api/auth/SIGN-IN/email',
      '/api/auth/sign-in%2Femail',
    ]) {
      const { response } = await send(path, authInit(ip, wrongSignIn), target);
      expect(response.status, path).toBe(404);
    }
    const withQuery = await send('/api/auth/sign-in/email?x=1', authInit(ip, wrongSignIn), target);
    await expectLimited(withQuery.response);
  });

  it('does not limit other auth routes such as get-session', async () => {
    const limiter = fakeLimiter(0);
    const target = envWith({ RL_AUTH: limiter.binding });
    const { response } = await send('/api/auth/get-session', { method: 'GET' }, target);
    expect(response.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });

  it('keys a request without cf-connecting-ip as unknown', async () => {
    const limiter = fakeLimiter(10);
    const target = envWith({ RL_AUTH: limiter.binding });
    await send('/api/auth/sign-in/email', authInit(undefined, wrongSignIn), target);
    expect(limiter.keys).toEqual(['auth:sign-in/email:unknown']);
  });

  it('fails open when the binding throws, and logs no address', async () => {
    captureLogs();
    const target = envWith({ RL_AUTH: brokenLimiter });
    const ip = '198.51.100.29';
    const { response } = await send('/api/auth/sign-in/email', authInit(ip, wrongSignIn), target);
    expect(response.status).toBe(401);
    const warn = logs.filter((line) => line.includes('rate_limit.unavailable'));
    expect(warn).toHaveLength(1);
    expect(JSON.parse(warn[0] ?? '{}')).toMatchObject({ level: 'warn', rule: 'auth' });
    expect(logs.join('\n')).not.toContain(ip);
  });

  it('does nothing without bindings: 30 sign-ins from one address get no 429', async () => {
    const target = env as unknown as Env;
    for (let i = 0; i < 30; i += 1) {
      const { response } = await send(
        '/api/auth/sign-in/email',
        authInit('198.51.100.30', wrongSignIn),
        target,
      );
      expect(response.status).not.toBe(429);
    }
  });
});

const dialsIn = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(call)));
const reservesIn = async (orgId: string) =>
  (await withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(ledgerEntry)))).filter(
    (e) => e.kind === 'reserve',
  );
const lockHolder = (userId: string) =>
  env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)).current();

async function grantedContact(u: User, phone: string): Promise<string> {
  const created = (await (
    await post('/api/v1/contacts', u.cookie, { displayName: 'Rate Limited', phone })
  ).json()) as Envelope<{ id: string }>;
  const id = created.data?.id;
  if (!id) throw new Error('contact not created');
  const r = await api(`/api/v1/contacts/${id}/permissions/manual_call`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: u.cookie },
    body: JSON.stringify({ status: 'granted' }),
  });
  expect(r.status).toBe(200);
  return id;
}

describe('dial rate limit', () => {
  it('limits the 11th dial or answer by one user, and the limited dial creates nothing', async () => {
    const u = await newUser('rl-dial');
    const contactId = await grantedContact(u, PHONE);
    const limiter = fakeLimiter(10);
    const target = envWith({ RL_DIAL: limiter.binding });
    for (let i = 0; i < 10; i += 1) {
      // Invalid bodies and unknown calls still count: the limit runs before the handler.
      const path = i % 2 === 0 ? '/api/v1/calls' : `/api/v1/calls/cl_${'0'.repeat(32)}/answer`;
      const { response } = await send(path, userInit(u.cookie, {}), target);
      expect(response.status).not.toBe(429);
    }
    const eleventh = await send(
      '/api/v1/calls',
      userInit(u.cookie, { contactId, idempotencyKey: `rl-${crypto.randomUUID()}` }),
      target,
    );
    await expectLimited(eleventh.response);
    expect(new Set(limiter.keys)).toEqual(new Set([`dial:${u.userId}`]));
    expect(await dialsIn(u.orgId)).toEqual([]);
    expect(await reservesIn(u.orgId)).toEqual([]);
    expect(await lockHolder(u.userId)).toBeNull();

    const other = await newUser('rl-dial-other');
    const otherContact = await grantedContact(other, PHONE);
    const allowed = await send(
      '/api/v1/calls',
      userInit(other.cookie, {
        contactId: otherContact,
        idempotencyKey: `rl-${crypto.randomUUID()}`,
      }),
      target,
    );
    expect(allowed.response.status).toBe(201);
  });
});

describe('voice token rate limit', () => {
  it('limits the 21st token for one user', async () => {
    const u = await newUser('rl-token');
    const limiter = fakeLimiter(20);
    const target = envWith({ RL_VOICE_TOKEN: limiter.binding });
    for (let i = 0; i < 20; i += 1) {
      const { response } = await send('/api/v1/voice/token', userInit(u.cookie), target);
      expect(response.status).toBe(200);
    }
    await expectLimited((await send('/api/v1/voice/token', userInit(u.cookie), target)).response);
    expect(new Set(limiter.keys)).toEqual(new Set([`token:${u.userId}`]));
  });

  it('fails open when the binding throws, and logs no user id', async () => {
    const u = await newUser('rl-token-broken');
    captureLogs();
    const target = envWith({ RL_VOICE_TOKEN: brokenLimiter });
    const { response } = await send('/api/v1/voice/token', userInit(u.cookie), target);
    expect(response.status).toBe(200);
    const warn = logs.filter((line) => line.includes('rate_limit.unavailable'));
    expect(warn).toHaveLength(1);
    expect(JSON.parse(warn[0] ?? '{}')).toMatchObject({
      level: 'warn',
      rule: 'voice_token',
      route: '/api/v1/voice/token',
    });
    const all = logs.join('\n');
    expect(all).not.toContain(u.userId);
    expect(all).not.toContain(u.orgId);
  });
});

describe('message send rate limit', () => {
  it('limits the 31st send in one organization, teammates included, and not other organizations', async () => {
    const u = await newUser('rl-send');
    const mate = await signUpTeammate(u.orgId);
    const limiter = fakeLimiter(30);
    const target = envWith({ RL_MESSAGE_SEND: limiter.binding });
    const path = `/api/v1/conversations/cv_${'0'.repeat(32)}/messages`;
    for (let i = 0; i < 30; i += 1) {
      const cookie = i % 2 === 0 ? u.cookie : mate.cookie;
      const { response } = await send(path, userInit(cookie, {}), target);
      expect(response.status).not.toBe(429);
    }
    await expectLimited((await send(path, userInit(mate.cookie, {}), target)).response);
    expect(new Set(limiter.keys)).toEqual(new Set([`send:${u.orgId}`]));

    const other = await newUser('rl-send-other');
    const allowed = await send(path, userInit(other.cookie, {}), target);
    expect(allowed.response.status).not.toBe(429);
  });

  it('does not limit reading messages', async () => {
    const u = await newUser('rl-send-read');
    const limiter = fakeLimiter(0);
    const target = envWith({ RL_MESSAGE_SEND: limiter.binding });
    const path = `/api/v1/conversations/cv_${'0'.repeat(32)}/messages`;
    const { response } = await send(path, { headers: { cookie: u.cookie } }, target);
    expect(response.status).not.toBe(429);
    expect(limiter.keys).toEqual([]);
  });
});

import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { Env } from '../env';
import type { AppEnv } from './context';
import { fail } from './envelope';
import { logger } from './logger';

/**
 * Durable rate limits: Workers Rate Limiting bindings, counted per Cloudflare location across every
 * isolate of the Worker. The bindings exist only in the staging and production env blocks of
 * wrangler.jsonc. Where one is absent (local dev, tests) its rule lets every request through.
 * Better Auth's own in-memory limiter stays on in deployed environments as defence in depth, but it
 * counts per isolate only: these bindings are the limit that holds.
 */
export interface RateLimitRule {
  name: 'auth' | 'dial' | 'voice_token' | 'message_send';
  binding: (env: Env) => RateLimit | undefined;
  key: (c: Context<AppEnv>) => string;
}

/** Retry-After for every limited response. The bindings count in 60 second periods. */
const RETRY_AFTER_SECONDS = '60';
const LIMITED_MESSAGE = 'Too many requests. Wait a minute and try again.';

/** Better Auth's mount point (`basePath` in auth/auth.ts). */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * Better Auth 1.7.20 POST endpoints that guess or spend a secret, rate limited per client address.
 * There is no `/forget-password` endpoint in this version (only the email-otp plugin's, which is
 * not installed). `/two-factor/verify-otp` is registered by the two-factor plugin even without an
 * OTP sender, so it is limited like the other verify paths.
 */
export const RATE_LIMITED_AUTH_ROUTES = [
  'sign-in/email',
  'sign-up/email',
  'request-password-reset',
  'reset-password',
  'two-factor/verify-totp',
  'two-factor/verify-backup-code',
  'two-factor/verify-otp',
] as const;

/**
 * The client address for rate limiting. Only `cf-connecting-ip`: Cloudflare sets it on every
 * request and clients cannot override it, unlike `x-forwarded-for`, `x-real-ip` or
 * `true-client-ip`. It is missing only outside Cloudflare (local dev, tests).
 */
export function clientIp(headers: Headers): string {
  return headers.get('cf-connecting-ip')?.trim() || 'unknown';
}

const HEXTETS = 8;
const PREFIX_HEXTETS = 4;
const HEXTET = /^[0-9a-f]{1,4}$/;
const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `a.b.c.d` as two hextets, or undefined when it is not a dotted quad. */
function quadToHextets(quad: string): [number, number] | undefined {
  const octets = DOTTED_QUAD.exec(quad)?.slice(1).map(Number);
  if (!octets || octets.some((o) => o > 255)) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  return [(a << 8) | b, (c << 8) | d];
}

/** One side of a `::`: its hextets, a dotted-quad tail included, or undefined if malformed. */
function parseHextets(half: string | undefined): number[] | undefined {
  if (!half) return [];
  const parts = half.split(':');
  const last = parts.at(-1) ?? '';
  const tail = last.includes('.') ? quadToHextets(last) : undefined;
  if (last.includes('.') && !tail) return undefined;
  const head = tail ? parts.slice(0, -1) : parts;
  if (!head.every((p) => HEXTET.test(p))) return undefined;
  return [...head.map((p) => Number.parseInt(p, 16)), ...(tail ?? [])];
}

/** The eight hextets of an IPv6 address, with `::` expanded, or undefined if malformed. */
function expandIpv6(address: string): number[] | undefined {
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return undefined;
  const left = parseHextets(halves[0]);
  const right = parseHextets(halves[1]);
  if (!left || !right) return undefined;
  const missing = HEXTETS - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

/** `::ffff:a.b.c.d`, an IPv4 client seen through IPv6, as `a.b.c.d`. */
function mappedIpv4(hextets: number[]): string | undefined {
  const mapped = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (!mapped) return undefined;
  const [hi = 0, lo = 0] = hextets.slice(6);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * The address group the auth limit counts: an IPv4 address as is, an IPv6 address as its /64
 * (`2001:db8:1:2::/64`). One IPv6 host usually holds a whole /64, so keying on the full address
 * would give every guess a fresh bucket; Better Auth's own limiter groups IPv6 the same way. An
 * IPv4-mapped address counts as its IPv4 address. Anything unparseable is used as is, lowercased.
 */
export function addressGroup(ip: string): string {
  if (!ip.includes(':')) return ip;
  const hextets = expandIpv6(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (!hextets) return ip.toLowerCase();
  const prefix = hextets.slice(0, PREFIX_HEXTETS).map((h) => h.toString(16));
  return mappedIpv4(hextets) ?? `${prefix.join(':')}::/64`;
}

/** The auth route a request is for, such as `sign-in/email`. */
function authRoute(c: Context<AppEnv>): string {
  return c.req.path.slice(AUTH_BASE_PATH.length + 1);
}

/** The rules from the M2b rate limit table. Limits and periods live in wrangler.jsonc. */
export const RULES: Record<RateLimitRule['name'], RateLimitRule> = {
  auth: {
    name: 'auth',
    binding: (env) => env.RL_AUTH,
    key: (c) => `auth:${authRoute(c)}:${addressGroup(clientIp(c.req.raw.headers))}`,
  },
  dial: {
    name: 'dial',
    binding: (env) => env.RL_DIAL,
    key: (c) => `dial:${c.var.tenant.userId}`,
  },
  voice_token: {
    name: 'voice_token',
    binding: (env) => env.RL_VOICE_TOKEN,
    key: (c) => `token:${c.var.tenant.userId}`,
  },
  message_send: {
    name: 'message_send',
    binding: (env) => env.RL_MESSAGE_SEND,
    key: (c) => `send:${c.var.tenant.orgId}`,
  },
};

/** True when the request may go on. Fails open: a binding error never blocks a request. */
async function allowed(
  rule: RateLimitRule,
  binding: RateLimit,
  key: string,
  route: string,
): Promise<boolean> {
  try {
    return (await binding.limit({ key })).success;
  } catch {
    // The key holds an address or an id, so it is never logged; neither is the error text.
    logger.warn('rate_limit.unavailable', { rule: rule.name, route });
    return true;
  }
}

/**
 * Answers 429 `rate_limited` once the rule's key is over its limit. Logs the rule and the route
 * pattern only, never the key, address or user id. Runs before the handler, so a limited request
 * does no work.
 */
export function rateLimit(rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const binding = rule.binding(c.env);
    if (!binding) return next();
    const route = routePath(c);
    if (await allowed(rule, binding, rule.key(c), route)) return next();
    logger.warn('rate_limit.hit', { rule: rule.name, route });
    c.header('Retry-After', RETRY_AFTER_SECONDS);
    return fail(c, 429, 'rate_limited', LIMITED_MESSAGE);
  });
}

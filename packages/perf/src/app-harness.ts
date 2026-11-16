// Runs the Hono API in-process under Node against the perf database, with a fake execution
// context so `waitUntil` work can be awaited. Used by seed, explain and load tools.
import { randomInt } from 'node:crypto';
import { app } from '@knoqra/api/app';
import type { PerfTarget } from './config';
import { ports } from './config';
import { readDevVars } from './dev-vars';

export type ApiResponse = { status: number; json: unknown; setCookie: string | null };

export type InProcessApi = {
  request(
    method: string,
    path: string,
    opts?: { body?: unknown; cookie?: string },
  ): Promise<ApiResponse>;
  signUp(name: string, email: string, password: string): Promise<string>;
  signIn(email: string, password: string): Promise<string>;
  flush(): Promise<void>;
};

/** Folds Set-Cookie headers (joined with ", ") into one Cookie request header. */
function cookieOf(setCookie: string | null): string {
  return (setCookie ?? '')
    .split(/,(?=\s*[^;,]+=)/)
    .map((part) => part.trim().split(';')[0])
    .filter(Boolean)
    .join('; ');
}

/** Builds an API client bound to `target`. Every request carries the web Origin header. */
export function createInProcessApi(target: PerfTarget): InProcessApi {
  const { webOrigin } = ports(process.env);
  const env = {
    ...readDevVars(),
    DATABASE_URL: target.appUrl,
    BETTER_AUTH_URL: webOrigin,
    APP_ENV: 'development',
    HYPERDRIVE: { connectionString: target.appUrl },
  };
  let pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  async function flush(): Promise<void> {
    while (pending.length > 0) {
      const batch = pending;
      pending = [];
      await Promise.allSettled(batch);
    }
  }

  async function request(
    method: string,
    path: string,
    opts: { body?: unknown; cookie?: string } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      origin: webOrigin,
      // Better Auth rate-limits on this header; a fresh address per call keeps it out of the way.
      'cf-connecting-ip': `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    };
    if (opts.cookie) headers.cookie = opts.cookie;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const response = await app.request(path, init, env as never, executionCtx);
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    const setCookie = response.headers.getSetCookie().join(', ') || null;
    return { status: response.status, json, setCookie };
  }

  async function authenticate(path: string, body: unknown, what: string): Promise<string> {
    const r = await request('POST', path, { body });
    if (r.status !== 200) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.json)}`);
    await flush();
    return cookieOf(r.setCookie);
  }

  return {
    request,
    flush,
    signUp: (name, email, password) =>
      authenticate('/api/auth/sign-up/email', { name, email, password }, 'sign-up'),
    signIn: (email, password) =>
      authenticate('/api/auth/sign-in/email', { email, password }, 'sign-in'),
  };
}

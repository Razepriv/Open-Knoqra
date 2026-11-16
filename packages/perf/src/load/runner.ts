// The load runner: virtual users driving the weighted request mix through a Transport, either
// global fetch over HTTP (wrangler, remote) or the in-process app (inprocess).
import type { InProcessApi } from '../app-harness';
import { fillBody } from '../explain/registry';
import { fillTemplate } from '../fixtures-template';
import type { Fixtures } from '../seed/fixtures';
import { mulberry32, type Rand } from '../seed/random';
import { type Sample, type Summary, summarize } from './stats';

export type MixRequest = { name?: string; method: string; path: string; body?: unknown };
export type Scenario = { name: string; weight: number; requests: MixRequest[] };
export type Mix = { scenarios: Scenario[] };

export type LoadResult = {
  vus: number;
  durationS: number;
  elapsedS: number;
  /** Keyed `scenario/request`. */
  requests: Record<string, Summary>;
  /** Wall time of each scenario (all of its requests, concurrent). */
  scenarios: Record<string, Summary>;
};

export const MAX_DURATION_S = 60;
export const P95_BUDGET_MS = 150;
/** Request names whose p95 must stay within budget. */
export const GATED: ReadonlySet<string> = new Set(['list', 'search', 'detail', 'timeline']);
const REQUEST_TIMEOUT_MS = 15_000;

/** Weighted pick; deterministic for a given generator. */
export function pickScenario(mix: Mix, rand: Rand): Scenario {
  const total = mix.scenarios.reduce((s, c) => s + c.weight, 0);
  let roll = rand() * total;
  for (const scenario of mix.scenarios) {
    roll -= scenario.weight;
    if (roll < 0) return scenario;
  }
  return mix.scenarios[mix.scenarios.length - 1] as Scenario;
}

/** `{rotate:a.b|c.d}` becomes `{a.b}` or `{c.d}` by iteration, before the usual templating. */
function rotate(path: string, iteration: number): string {
  return path.replace(/\{rotate:([^}]+)\}/g, (_m, keys: string) => {
    const list = keys.split('|');
    return `{${list[iteration % list.length]}}`;
  });
}

export function resolveRequest(
  request: MixRequest,
  fixtures: Fixtures,
  iteration: number,
): { path: string; body: unknown } {
  return {
    path: fillTemplate(rotate(request.path, iteration), fixtures),
    body: request.body === undefined ? undefined : fillBody(request.body, fixtures),
  };
}

/**
 * Resolves every request of every scenario for several iterations (covers `{rotate:...}`).
 * Returns the first error message, or null when everything resolves.
 */
export function preflightMix(mix: Mix, fixtures: Fixtures, iterations = 8): string | null {
  for (const scenario of mix.scenarios) {
    for (const request of scenario.requests) {
      for (let i = 0; i < iterations; i++) {
        try {
          resolveRequest(request, fixtures, i);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return `mix ${scenario.name}/${requestLabel(request)}: ${reason}`;
        }
      }
    }
  }
  return null;
}

/** The label a request is reported under: its name, else method and path without the query. */
export function requestLabel(request: MixRequest): string {
  return request.name ?? `${request.method} ${request.path.split('?')[0]}`;
}

async function send(
  origin: string,
  webOrigin: string,
  cookie: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; cookie: string }> {
  const headers: Record<string, string> = { origin: webOrigin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.arrayBuffer();
  const pairs = res.headers.getSetCookie().map((c) => c.split(';')[0] as string);
  return { ok: res.ok, cookie: pairs.join('; ') };
}

/** Signs in once and returns the Cookie header value; throws when the sign-in fails. */
export async function signInCookie(
  origin: string,
  webOrigin: string,
  email: string,
  password: string,
): Promise<string> {
  const r = await send(origin, webOrigin, '', 'POST', '/api/auth/sign-in/email', {
    email,
    password,
  });
  if (!r.ok || r.cookie === '') throw new Error('sign-in failed (no session cookie)');
  return r.cookie;
}

/**
 * The one request signature every target shares. `send` resolves true on a 2xx response and is
 * what the runner times; `signIn` returns the Cookie header value or throws.
 */
export type Transport = {
  signIn(email: string, password: string): Promise<string>;
  send(method: string, path: string, body: unknown, cookie: string): Promise<boolean>;
};

/** HTTP on global fetch; every request carries `webOrigin` as its Origin header. */
export function httpTransport(origin: string, webOrigin: string): Transport {
  return {
    signIn: (email, password) => signInCookie(origin, webOrigin, email, password),
    send: async (method, path, body, cookie) =>
      (await send(origin, webOrigin, cookie, method, path, body)).ok,
  };
}

/** The Hono app in-process (app-harness); a call is timed around `request` alone. */
export function inProcessTransport(api: InProcessApi): Transport {
  return {
    signIn: (email, password) => api.signIn(email, password),
    send: async (method, path, body, cookie) => {
      const r = await api.request(method, path, { body, cookie });
      return r.status >= 200 && r.status <= 299;
    },
  };
}

/** Shares one sign-in across every caller (remote: staging rate-limits sign-in per IP). */
export function signInOnce(transport: Transport): Transport {
  let session: Promise<string> | undefined;
  return {
    send: transport.send,
    signIn: (email, password) => {
      session ??= transport.signIn(email, password);
      return session;
    },
  };
}

async function timed(run: () => Promise<boolean>): Promise<Sample> {
  const start = performance.now();
  let ok = false;
  try {
    ok = await run();
  } catch {
    ok = false;
  }
  return { ms: performance.now() - start, ok };
}

export type LoadOptions = {
  transport: Transport;
  mix: Mix;
  fixtures: Fixtures;
  vus?: number;
  durationS?: number;
  /**
   * Fire a scenario's requests one at a time (inprocess, Ruling L-c) instead of in parallel as a
   * browser does (remote, wrangler).
   */
  sequential?: boolean;
};

type Bucket = Record<string, Sample[]>;
type Keyed = readonly [string, Sample];

/** Runs `each` over `items`, in parallel or one at a time, keeping the input order. */
async function runEach<T, R>(
  items: readonly T[],
  sequential: boolean,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!sequential) return Promise.all(items.map(each));
  const results: R[] = [];
  for (const item of items) results.push(await each(item));
  return results;
}

async function virtualUser(
  index: number,
  opts: LoadOptions,
  deadline: number,
  requests: Bucket,
  scenarios: Bucket,
): Promise<void> {
  const { transport, mix, fixtures } = opts;
  const { email, password } = fixtures.ownerA;
  let cookie: string;
  try {
    cookie = await transport.signIn(email, password);
  } catch {
    // A failed sign-in is an error sample, not a rejected run.
    const list = requests['setup/sign-in'] ?? [];
    list.push({ ms: 0, ok: false });
    requests['setup/sign-in'] = list;
    return;
  }
  const rand = mulberry32(index);
  for (let iteration = index; performance.now() < deadline; iteration++) {
    const scenario = pickScenario(mix, rand);
    const wall = await timed(async () => {
      const samples = await runEach(
        scenario.requests,
        opts.sequential ?? false,
        async (request): Promise<Keyed> => {
          const key = `${scenario.name}/${requestLabel(request)}`;
          const sample = await timed(async () => {
            const { path, body } = resolveRequest(request, fixtures, iteration);
            return transport.send(request.method, path, body, cookie);
          });
          return [key, sample];
        },
      );
      let allOk = true;
      for (const [key, sample] of samples) {
        const list = requests[key] ?? [];
        list.push(sample);
        requests[key] = list;
        allOk &&= sample.ok;
      }
      return allOk;
    });
    const walls = scenarios[scenario.name] ?? [];
    walls.push(wall);
    scenarios[scenario.name] = walls;
    // A synchronous failure path has only microtasks; yield a macrotask so the loop never spins.
    if (!wall.ok) await new Promise<void>((r) => setImmediate(r));
  }
}

/** Runs `vus` virtual users for `durationS` (capped at 60 s). Sign-ins are not in the stats. */
export async function runLoad(opts: LoadOptions): Promise<LoadResult> {
  const vus = opts.vus ?? 10;
  const durationS = Math.min(opts.durationS ?? 30, MAX_DURATION_S);
  const requests: Bucket = {};
  const scenarios: Bucket = {};
  const start = performance.now();
  const deadline = start + durationS * 1000;
  await Promise.all(
    Array.from({ length: vus }, (_, i) => virtualUser(i, opts, deadline, requests, scenarios)),
  );
  const elapsedS = (performance.now() - start) / 1000;
  const summarizeAll = (b: Bucket) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, summarize(v, elapsedS)]));
  return {
    vus,
    durationS,
    elapsedS,
    requests: summarizeAll(requests),
    scenarios: summarizeAll(scenarios),
  };
}

/**
 * The reasons a run fails: any error, or a gated request over the p95 budget. With
 * `gate: false` (the informational wrangler target) only errors count.
 */
export function verdict(
  result: Pick<LoadResult, 'requests'>,
  opts: { gate?: boolean } = {},
): string[] {
  const gate = opts.gate ?? true;
  const problems: string[] = [];
  for (const [key, s] of Object.entries(result.requests)) {
    if (s.errors > 0) problems.push(`${key}: ${s.errors} errors`);
    const name = key.slice(key.indexOf('/') + 1);
    if (gate && GATED.has(name) && s.p95 > P95_BUDGET_MS) {
      problems.push(`${key}: p95 ${s.p95.toFixed(1)} ms over ${P95_BUDGET_MS} ms`);
    }
  }
  return problems;
}

export type SingleUserRoute = { label: string; method: string; path: string };
export type SingleUserResult = { label: string; medianMs: number; errors: number };

/** Times `count` sequential requests per route on one session and reports each route's median. */
export async function singleUser(
  transport: Transport,
  cookie: string,
  routes: readonly SingleUserRoute[],
  count = 15,
): Promise<SingleUserResult[]> {
  const results: SingleUserResult[] = [];
  for (const route of routes) {
    const samples: Sample[] = [];
    for (let i = 0; i < count; i++) {
      samples.push(await timed(() => transport.send(route.method, route.path, undefined, cookie)));
    }
    const s = summarize(samples, 1);
    results.push({ label: route.label, medianMs: s.p50, errors: s.errors });
  }
  return results;
}

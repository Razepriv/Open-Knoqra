// `pnpm perf:realtime --database <name>`: opens 200 WebSockets against the Durable Object
// endpoint and measures fan-out delivery. Skips while apps/api/wrangler.jsonc has no DO bindings.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isEntryPoint, loadFixtures, REPO_ROOT, resolveTarget } from '../config';
import { postgresVersion } from '../explain/replay';
import { signInCookie } from '../load/runner';
import { percentile } from '../load/stats';
import { machineSummary } from '../machine';
import { fail, out } from '../out';
import type { Fixtures } from '../seed/fixtures';
import { startServers, stopOnSignals } from '../server';
import { REALTIME } from './config';

export const SKIP_LINE =
  'SKIP perf:realtime: no Durable Object bindings in apps/api/wrangler.jsonc yet (they land with M2).';

/** Removes // and block comments outside of strings. */
function stripJsonComments(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      result += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      result += c;
      i++;
    }
  }
  return result;
}

/** The WebSocket URL of the realtime endpoint on an API origin. */
export function realtimeUrl(apiOrigin: string, path: string): string {
  return `${apiOrigin.replace(/^http/, 'ws')}${path}`;
}

/** Repo-relative path of the realtime report for a date. */
export function realtimeReportPath(date: string): string {
  return `docs/perf/${date}-realtime.md`;
}

/** Removes a comma that is directly followed (after whitespace) by `}` or `]`, outside strings. */
function stripTrailingCommas(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      result += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
      i++;
    } else {
      result += c;
      i++;
    }
  }
  return result;
}

/**
 * True when the top-level `durable_objects.bindings` is a non-empty array. Throws when the text
 * is not valid JSONC, so a broken file can never be mistaken for "no bindings".
 */
export function hasDurableObjects(wranglerJsonc: string): boolean {
  let parsed: { durable_objects?: { bindings?: unknown } };
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(wranglerJsonc)));
  } catch {
    throw new Error('apps/api/wrangler.jsonc is not valid JSONC; cannot tell if it has bindings');
  }
  const bindings = parsed.durable_objects?.bindings;
  return Array.isArray(bindings) && bindings.length > 0;
}

/** A reason the run must FAIL before measuring anything, or null when it can measure fan-out. */
export function realtimeConfigProblem(
  config: Pick<typeof REALTIME, 'trigger' | 'expectType'>,
): string | null {
  return config.trigger && config.expectType
    ? null
    : 'bindings exist but no fan-out is configured: configure realtime/config.ts trigger and expectType';
}

type SocketLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
};
type SocketCtor = new (url: string, options: { headers: Record<string, string> }) => SocketLike;

/** Sockets opened so far, and per socket the time it received `expectType`. */
type SocketSet = { sockets: SocketLike[]; received: Promise<number>[] };

/** Opens one socket into `set` and resolves once it is open; rejects on a socket error. */
function openOne(url: string, headers: Record<string, string>, set: SocketSet): Promise<void> {
  // Node's global WebSocket is undici's and accepts `{ headers }`; the DOM typings do not say so.
  const Ctor = (globalThis as unknown as { WebSocket: SocketCtor }).WebSocket;
  const socket = new Ctor(url, { headers });
  set.sockets.push(socket);
  set.received.push(
    new Promise<number>((resolveMsg) => {
      socket.addEventListener('message', (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        let type: unknown;
        try {
          type = (JSON.parse(text) as { type?: unknown }).type;
        } catch {
          return;
        }
        if (type === REALTIME.expectType) resolveMsg(performance.now());
      });
    }),
  );
  return new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen());
    socket.addEventListener('error', () => reject(new Error('socket error')));
  });
}

/**
 * Opens `count` sockets into `set`, `concurrency` at a time. Every socket stays open until the
 * caller closes `set.sockets`, so all of them are connected when the trigger fires.
 */
export async function openInBatches(
  count: number,
  concurrency: number,
  open: () => Promise<void>,
): Promise<void> {
  for (let done = 0; done < count; done += concurrency) {
    const size = Math.min(concurrency, count - done);
    await Promise.all(Array.from({ length: size }, () => open()));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The markdown report; `failure` marks it FAIL with a one-line reason. */
export function renderRealtimeReport(
  date: string,
  lines: string[],
  failure: string | null,
  postgres?: string,
): string {
  return `${[
    `# Realtime report ${date}`,
    '',
    `Overall: ${failure === null ? 'PASS' : '**FAIL**'}`,
    '',
    `- Machine: ${machineSummary(postgres)}`,
    ...lines,
    ...(failure === null ? [] : [`- **FAIL**: ${failure}`]),
  ].join('\n')}\n`;
}

async function fanOut(
  servers: { apiOrigin: string; webOrigin: string },
  cookie: string,
  set: SocketSet,
  lines: string[],
): Promise<void> {
  const url = realtimeUrl(servers.apiOrigin, REALTIME.path);
  const headers = { Cookie: cookie, Origin: servers.webOrigin };
  const openStart = performance.now();
  await withTimeout(
    openInBatches(REALTIME.sockets, REALTIME.openConcurrency, () => openOne(url, headers, set)),
    REALTIME.openTimeoutMs,
    'opening sockets',
  );
  lines.push(
    `- Opened ${REALTIME.sockets} sockets, ${REALTIME.openConcurrency} at a time, in ${((performance.now() - openStart) / 1000).toFixed(1)} s`,
  );
  const t = REALTIME.trigger;
  if (!t) throw new Error(realtimeConfigProblem(REALTIME) ?? 'no trigger configured');
  const start = performance.now();
  const res = await fetch(`${servers.apiOrigin}${t.path}`, {
    method: t.method,
    headers: {
      cookie,
      origin: servers.webOrigin,
      ...(t.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: t.body === undefined ? undefined : JSON.stringify(t.body),
  });
  if (!res.ok) throw new Error(`trigger ${t.method} ${t.path} returned HTTP ${res.status}`);
  const times = await withTimeout(Promise.all(set.received), REALTIME.timeoutMs, 'fan-out');
  const ms = times.map((x) => x - start).sort((a, b) => a - b);
  lines.push(
    `- Fan-out (${REALTIME.expectType}): p50 ${percentile(ms, 50).toFixed(1)} ms, p95 ${percentile(ms, 95).toFixed(1)} ms, max ${(ms[ms.length - 1] ?? 0).toFixed(1)} ms`,
  );
}

async function main(): Promise<void> {
  const wrangler = readFileSync(join(REPO_ROOT, 'apps', 'api', 'wrangler.jsonc'), 'utf8');
  if (!hasDurableObjects(wrangler)) {
    out(SKIP_LINE);
    return;
  }
  const target = resolveTarget(process.argv.slice(2), process.env);
  if (!target.ok) fail(target.error);
  let fixtures: Fixtures;
  try {
    fixtures = loadFixtures(target.value.database);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const postgres = await postgresVersion(target.value.adminUrl).catch(() => undefined);
  const lines: string[] = [];
  let failure: string | null = realtimeConfigProblem(REALTIME);
  let servers: Awaited<ReturnType<typeof startServers>> | undefined;
  const set: SocketSet = { sockets: [], received: [] };
  const removeHandlers = stopOnSignals(() => {
    for (const s of set.sockets) s.close();
  });
  try {
    if (failure !== null) throw new Error(failure);
    servers = await startServers({ target: target.value, web: false });
    const { email, password } = fixtures.ownerA;
    const cookie = await signInCookie(servers.apiOrigin, servers.webOrigin, email, password);
    await fanOut(servers, cookie, set, lines);
  } catch (error) {
    failure =
      (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0] ?? 'failed';
  } finally {
    for (const s of set.sockets) s.close();
    await servers?.stop();
    removeHandlers();
  }
  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(REPO_ROOT, realtimeReportPath(date));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderRealtimeReport(date, lines, failure, postgres));
  for (const l of lines) out(l.replace(/^- /, ''));
  if (failure !== null) fail(`FAIL perf:realtime: ${failure}`);
}

// Run only as the entry point, so tests can import hasDurableObjects.
if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}

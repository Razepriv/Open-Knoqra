// Starts the API (wrangler dev) and optionally the built web app (vite preview) for the perf
// tools, against the perf database. `stop` kills the whole process tree.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertAppRole, loadFixtures, type PerfTarget, ports, REPO_ROOT } from './config';
import { readDevVars } from './dev-vars';
import { signInCookie } from './load/runner';

export type RunningServers = {
  apiOrigin: string;
  webOrigin: string;
  stop(): Promise<void>;
};

const API_TIMEOUT_MS = 120_000;
const WEB_TIMEOUT_MS = 60_000;
const PERF_DIR = join(REPO_ROOT, '.perf');
const DEV_VARS_PERF = join(PERF_DIR, 'dev.vars.perf');

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number, child: ChildProcess, what: string) {
  const deadline = Date.now() + timeoutMs;
  let exited = child.exitCode !== null;
  child.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${what} exited before it became healthy`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not become healthy within ${timeoutMs / 1000} s`);
}

/** A copy of apps/api/.dev.vars with DATABASE_URL pointing at the perf database. */
function writePerfDevVars(appUrl: string): void {
  const vars = { ...readDevVars(), DATABASE_URL: appUrl };
  mkdirSync(PERF_DIR, { recursive: true });
  const text = Object.entries(vars)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
  writeFileSync(DEV_VARS_PERF, `${text}\n`);
}

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

/** Paths (relative to the repo root) whose changes make the web build stale. */
export const WEB_BUILD_INPUTS: readonly string[] = [
  'apps/web/src',
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/public',
  'packages/ui/src',
  'packages/tokens',
  'packages/brand',
];

/** True when `dist` is missing or older than any input; pure over a mtime lookup for tests. */
export function isBuildStale(distMtime: number, inputMtimes: readonly number[]): boolean {
  return distMtime === 0 || inputMtimes.some((m) => m > distMtime);
}

function webBuildIsStale(): boolean {
  const dist = join(REPO_ROOT, 'apps', 'web', 'dist');
  if (!existsSync(dist)) return true;
  return isBuildStale(
    newestMtime(dist),
    WEB_BUILD_INPUTS.map((p) => newestMtime(join(REPO_ROOT, p))),
  );
}

function run(command: string, env: NodeJS.ProcessEnv): ChildProcess {
  // One command string with a shell: Windows needs it to find pnpm.cmd. Off Windows the child
  // leads its own process group, so the whole tree can be signalled through the negative pid.
  return spawn(command, {
    cwd: REPO_ROOT,
    shell: true,
    stdio: 'ignore',
    env,
    detached: process.platform !== 'win32',
  });
}

export type KillStep =
  | { kind: 'taskkill'; args: string[] }
  | { kind: 'signal'; target: number; signal: 'SIGTERM' | 'SIGKILL' };

/** The kill steps for a process tree rooted at `pid`, in order (pure, so it can be tested). */
export function killPlan(platform: NodeJS.Platform, pid: number): KillStep[] {
  if (platform === 'win32') {
    return [{ kind: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] }];
  }
  return [
    { kind: 'signal', target: -pid, signal: 'SIGTERM' },
    { kind: 'signal', target: -pid, signal: 'SIGKILL' },
  ];
}

const KILL_GRACE_MS = 1500;

/** Kills the tree by pid even when the root already exited (workerd can outlive it). */
async function kill(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  for (const step of killPlan(process.platform, pid)) {
    if (step.kind === 'taskkill') {
      spawnSync('taskkill', step.args, { stdio: 'ignore' });
      continue;
    }
    try {
      process.kill(step.target, step.signal);
    } catch {
      return; // group already gone
    }
    if (step.signal === 'SIGTERM') await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
  }
}

/**
 * Builds an idempotent stopper over a child list: it drains the list, concurrent calls share the
 * in-flight promise, and a later call with an empty list does nothing.
 */
export function makeStopper<T>(
  list: T[],
  killer: (child: T) => Promise<void>,
): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  return () => {
    inflight ??= Promise.all(list.splice(0).map(killer))
      .then(() => undefined)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

/** Every child spawned by `startServers` that is still alive, so a signal can reach them. */
const spawned: ChildProcess[] = [];
const stopAll = makeStopper(spawned, kill);

/** Awaits `before` (errors swallowed), then `stop`, then `exit`; exits even if `stop` fails. */
export async function runShutdown(
  before: (() => void | Promise<void>) | undefined,
  stop: () => Promise<void>,
  exit: (code: number) => void,
  code: number,
): Promise<void> {
  await Promise.resolve()
    .then(() => before?.())
    .catch(() => undefined);
  await stop().catch(() => undefined);
  exit(code);
}

/**
 * Runs `before`, then stops every spawned server on SIGINT or SIGTERM, then exits. Works during
 * startup too. Returns a function that removes the handlers.
 */
export function stopOnSignals(before?: () => void | Promise<void>): () => void {
  const handler = (signal: NodeJS.Signals) => {
    void runShutdown(before, stopAll, process.exit, signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export async function startServers(opts: {
  target: PerfTarget;
  web: boolean;
}): Promise<RunningServers> {
  await assertAppRole(opts.target.appUrl);
  const { apiPort, webPort, apiOrigin, webOrigin } = ports(process.env);
  const checks = [`${apiOrigin}/api/health`, ...(opts.web ? [`${webOrigin}/`] : [])];
  for (const url of checks) {
    if (await answers(url)) throw new Error(`port in use; stop the other server (${url})`);
  }
  const fixtures = loadFixtures(opts.target.database);
  writePerfDevVars(opts.target.appUrl);

  const children = spawned;
  const stop = stopAll;
  const env = {
    ...process.env,
    KNOQRA_WEB_PORT: String(webPort),
    KNOQRA_API_PORT: String(apiPort),
  };
  try {
    const api = run(
      `pnpm --filter @knoqra/api exec wrangler dev --port ${apiPort} --env-file "${DEV_VARS_PERF}"`,
      env,
    );
    children.push(api);
    await waitFor(`${apiOrigin}/api/health`, API_TIMEOUT_MS, api, 'the API');
    if (opts.web) {
      if (webBuildIsStale()) {
        const build = spawnSync('pnpm --filter @knoqra/web exec vite build', {
          cwd: REPO_ROOT,
          shell: true,
          stdio: 'ignore',
          env,
        });
        if (build.status !== 0) throw new Error('vite build failed');
      }
      const web = run(
        `pnpm --filter @knoqra/web exec vite preview --port ${webPort} --strictPort`,
        env,
      );
      children.push(web);
      await waitFor(`${webOrigin}/api/health`, WEB_TIMEOUT_MS, web, 'the web preview');
    }
    // Only the perf database holds owner A, so a successful sign-in proves the target.
    const { email, password } = fixtures.ownerA;
    await signInCookie(apiOrigin, webOrigin, email, password).catch(() => {
      throw new Error('sign-in as owner A failed: the API is not serving the perf database');
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { apiOrigin, webOrigin, stop };
}

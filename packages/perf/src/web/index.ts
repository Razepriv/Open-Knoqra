// `pnpm perf:web --database <name> [--out <file>] [--runs 3]`
// Builds (if stale) and serves the web app and API on the perf database, signs in as owner A in a
// Playwright Chromium, runs Lighthouse (desktop) on each page, and writes a markdown report with
// the bundle table. Exits 1 on any budget violation (the report is still written).
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { flagValue, isEntryPoint, loadFixtures, REPO_ROOT, resolveTarget } from '../config';
import { postgresVersion } from '../explain/replay';
import { fillTemplate } from '../fixtures-template';
import { machineSummary } from '../machine';
import { fail, out } from '../out';
import type { Fixtures } from '../seed/fixtures';
import { startServers, stopOnSignals } from '../server';
import {
  aggregate,
  type BundleResult,
  type LhrLike,
  PAGES,
  type PageDef,
  type PageResult,
  renderWebReport,
} from './budgets';
import { freePort, runLighthouse } from './lighthouse';

const SIGN_IN_TIMEOUT_MS = 30_000;
const PROFILE_DIR = join(REPO_ROOT, '.perf', 'chrome-profile');

/** Runs the bundle check; it exits 1 on a violation but still prints its JSON. */
function bundleCheck(): BundleResult {
  const run = spawnSync('node', ['scripts/check-bundle-budget.mjs', '--json'], {
    cwd: join(REPO_ROOT, 'apps', 'web'),
    encoding: 'utf8',
  });
  const line = run.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as BundleResult;
  } catch {
    throw new Error('the bundle check printed no JSON (is apps/web built?)');
  }
}

type SignInPage = {
  goto(url: string): Promise<unknown>;
  getByLabel(label: string): { fill(value: string): Promise<void> };
  getByRole(
    role: 'button' | 'navigation',
    opts: { name: string },
  ): { click(): Promise<void>; waitFor(opts: { timeout: number }): Promise<void> };
};

async function signIn(page: SignInPage, webOrigin: string, fixtures: Fixtures): Promise<void> {
  await page.goto(`${webOrigin}/sign-in`);
  await page.getByLabel('Email').fill(fixtures.ownerA.email);
  await page.getByLabel('Password').fill(fixtures.ownerA.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  try {
    await page
      .getByRole('navigation', { name: 'Primary' })
      .waitFor({ timeout: SIGN_IN_TIMEOUT_MS });
  } catch {
    throw new Error(
      `UI sign-in did not reach the Primary navigation within ${SIGN_IN_TIMEOUT_MS / 1000} s`,
    );
  }
}

async function measure(def: PageDef, url: string, port: number, runs: number): Promise<PageResult> {
  const results: LhrLike[] = [];
  for (let i = 0; i < runs; i++) {
    out(`  ${def.name}: run ${i + 1}/${runs}`);
    results.push(await runLighthouse(url, port));
  }
  return aggregate(def.name, results);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = resolveTarget(argv, process.env);
  if (!target.ok) fail(target.error);
  const runs = Number(flagValue(argv, '--runs') ?? 3);
  if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
  const date = new Date().toISOString().slice(0, 10);
  const outFile = resolve(
    REPO_ROOT,
    flagValue(argv, '--out') ?? join('docs', 'perf', `${date}-web.md`),
  );
  let fixtures: Fixtures;
  try {
    fixtures = loadFixtures(target.value.database);
  } catch (error) {
    return fail(firstLine(error));
  }
  const postgres = await postgresVersion(target.value.adminUrl).catch(() => undefined);

  let servers: Awaited<ReturnType<typeof startServers>> | undefined;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const cleanup = async () => {
    await context?.close().catch(() => undefined);
    await servers?.stop();
  };
  const removeHandlers = stopOnSignals(cleanup);
  let bundle: BundleResult = { initialBytes: 0, files: [], violations: [], sizes: {} };
  const pages: PageResult[] = [];
  const failures: string[] = [];
  try {
    // startServers builds the web app when it is stale, so dist exists for the bundle check.
    servers = await startServers({ target: target.value, web: true });
    const origin = servers.webOrigin;
    try {
      bundle = bundleCheck();
    } catch (error) {
      bundle = { ...bundle, violations: [`bundle check failed: ${firstLine(error)}`] };
    }
    rmSync(PROFILE_DIR, { recursive: true, force: true });
    const debugPort = await freePort();
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: [`--remote-debugging-port=${debugPort}`],
    });
    const urlOf = (def: PageDef) => `${origin}${fillTemplate(def.path, fixtures)}`;
    const measureAll = async (defs: PageDef[]) => {
      for (const def of defs) {
        try {
          pages.push(await measure(def, urlOf(def), debugPort, runs));
        } catch (error) {
          failures.push(`${def.name}: Lighthouse failed: ${firstLine(error)}`);
          return false;
        }
      }
      return true;
    };
    if (await measureAll(PAGES.filter((p) => !p.auth))) {
      const authed = PAGES.filter((p) => p.auth);
      if (authed.length > 0) {
        // The sign-in page stays open until the context closes.
        const page = await context.newPage();
        try {
          await signIn(page, origin, fixtures);
          await measureAll(authed);
        } catch (error) {
          failures.push(`${authed[0]?.name ?? 'authenticated pages'}: ${firstLine(error)}`);
        }
      }
    }
  } catch (error) {
    failures.push(`run aborted: ${firstLine(error)}`);
  } finally {
    await cleanup();
    removeHandlers();
  }

  const report = renderWebReport({
    date,
    database: target.value.database,
    machine: machineSummary(postgres),
    bundle,
    pages,
    failures,
  });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, report);
  out(`wrote ${outFile}`);
  const problems = [...bundle.violations, ...pages.flatMap((p) => p.violations), ...failures];
  for (const problem of problems) process.stderr.write(`FAIL ${problem}\n`);
  process.exit(problems.length > 0 ? 1 : 0);
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/)[0] ?? text;
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => fail(firstLine(error)));
}

// Target-database guard and port resolution for the perf tools. Every tool resolves its target
// here so none can touch a database the perf stream does not own.
import { readFileSync } from 'node:fs';
import { err, ok, type Result } from '@knoqra/core';
import pg from 'pg';
import { FIXTURES_PATH, isEntryPoint, REPO_ROOT } from './paths';
import type { Fixtures } from './seed/fixtures';

export { FIXTURES_PATH, isEntryPoint, REPO_ROOT };

export type PerfTarget = { database: string; adminUrl: string; appUrl: string; force: boolean };

const PROTECTED_DATABASES: readonly string[] = ['knoqra', 'knoqra_m1'];

/** The value of `--flag value` or `--flag=value`, or undefined when the flag is absent. */
export function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function databaseOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

function refusal(name: string, force: boolean): string | null {
  if (PROTECTED_DATABASES.includes(name)) {
    return `refusing to use protected database "${name}" (--force does not apply)`;
  }
  if (force) return null;
  if (!name.includes('perf')) {
    return `refusing database "${name}": the name must contain "perf" (pass --force to override)`;
  }
  return null;
}

/** Resolves and guards the database a perf tool will use. */
export function resolveTarget(argv: string[], env: NodeJS.ProcessEnv): Result<PerfTarget, string> {
  const force = argv.includes('--force');
  const appOverride = env.PERF_DATABASE_URL || undefined;
  const adminOverride = env.PERF_ADMIN_DATABASE_URL || undefined;
  for (const [variable, url] of [
    ['PERF_DATABASE_URL', appOverride],
    ['PERF_ADMIN_DATABASE_URL', adminOverride],
  ] as const) {
    if (url !== undefined && databaseOf(url) === undefined) {
      return err(`${variable} must name a database (.../<name>)`);
    }
  }
  const database =
    flagValue(argv, '--database') ?? databaseOf(appOverride) ?? databaseOf(adminOverride);
  if (!database) return err('pass --database <name>');

  const appName = databaseOf(appOverride);
  const adminName = databaseOf(adminOverride);
  const names = new Set([database, appName, adminName]);
  // Protected names are refused first, from any input and even with --force.
  for (const name of names) {
    if (name !== undefined && PROTECTED_DATABASES.includes(name)) {
      return err(refusal(name, force) ?? '');
    }
  }
  if (appName !== undefined && adminName !== undefined && appName !== adminName) {
    return err(
      `PERF_DATABASE_URL (${appName}) and PERF_ADMIN_DATABASE_URL (${adminName}) must name the same database`,
    );
  }
  const explicit = flagValue(argv, '--database');
  for (const [variable, name] of [
    ['PERF_DATABASE_URL', appName],
    ['PERF_ADMIN_DATABASE_URL', adminName],
  ] as const) {
    if (explicit !== undefined && name !== undefined && name !== explicit) {
      return err(`--database ${explicit} does not match the database in ${variable} (${name})`);
    }
  }
  for (const name of names) {
    if (name === undefined) continue;
    const reason = refusal(name, force);
    if (reason) return err(reason);
  }
  return ok({
    database,
    adminUrl: adminOverride ?? `postgres://knoqra:knoqra@localhost:54329/${database}`,
    appUrl: appOverride ?? `postgres://knoqra_app:knoqra_app@localhost:54329/${database}`,
    force,
  });
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1024 and 65535, got "${raw}".`);
  }
  return value;
}

/** Web and API ports (defaults 5173 and 8787), read like apps/web/e2e/ports.ts. */
export function ports(env: NodeJS.ProcessEnv): {
  webPort: number;
  apiPort: number;
  webOrigin: string;
  apiOrigin: string;
} {
  const webPort = port(env, 'KNOQRA_WEB_PORT', 5173);
  const apiPort = port(env, 'KNOQRA_API_PORT', 8787);
  return {
    webPort,
    apiPort,
    webOrigin: `http://localhost:${webPort}`,
    apiOrigin: `http://localhost:${apiPort}`,
  };
}

/** Throws unless the app URL connects as the RLS-bound role: knoqra_app, no superuser, no BYPASSRLS. */
export async function assertAppRole(appUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ name: string; super: boolean; bypass: boolean }>(
      `select current_user as name, r.rolsuper as super, r.rolbypassrls as bypass
         from pg_roles r where r.rolname = current_user`,
    );
    const row = rows[0];
    if (row?.name !== 'knoqra_app' || row.super || row.bypass) {
      throw new Error(
        `the app URL must connect as knoqra_app without superuser or BYPASSRLS (got ${row?.name ?? 'unknown'})`,
      );
    }
  } finally {
    await client.end();
  }
}

/** Parses fixtures text for `database`; throws a one-line message when missing or mismatched. */
export function parseFixtures(text: string | undefined, database: string): Fixtures {
  const rerun = `run pnpm perf:seed --database ${database} first`;
  if (text === undefined) throw new Error(`no fixtures for ${database}: ${rerun}`);
  let fixtures: Fixtures;
  try {
    fixtures = JSON.parse(text) as Fixtures;
  } catch {
    throw new Error(`unreadable fixtures for ${database}: ${rerun}`);
  }
  if (fixtures.database !== database) {
    throw new Error(`fixtures were seeded for ${fixtures.database}, not ${database}: ${rerun}`);
  }
  return fixtures;
}

/** Reads `.perf/fixtures.json` and checks it belongs to `database`. */
export function loadFixtures(database: string, path: string = FIXTURES_PATH): Fixtures {
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = undefined;
  }
  return parseFixtures(text, database);
}

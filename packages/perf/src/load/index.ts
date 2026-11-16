// `pnpm perf:load --database <name> [--target inprocess|wrangler|remote] [--vus <n>]
//   [--duration 30] [--out <file>] [--note <text>]`
// --vus defaults to 1 for inprocess and 10 otherwise (Ruling L-b).
// remote also needs `--api-origin <https url> --web-origin <https url>`.
// Warms up, runs the mix against the target, and writes a markdown report. inprocess and remote
// exit 1 on any error or any gated p95 over 150 ms; wrangler is informational and exits 1 only on
// errors (the report is still written, marked FAIL).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import {
  flagValue,
  isEntryPoint,
  loadFixtures,
  type PerfTarget,
  REPO_ROOT,
  resolveTarget,
} from '../config';
import { postgresVersion } from '../explain/replay';
import { fillTemplate } from '../fixtures-template';
import { machineSummary } from '../machine';
import { fail, out } from '../out';
import type { Fixtures } from '../seed/fixtures';
import { startServers, stopOnSignals } from '../server';
import {
  httpTransport,
  inProcessTransport,
  type LoadResult,
  type Mix,
  P95_BUDGET_MS,
  preflightMix,
  runLoad,
  type SingleUserResult,
  type SingleUserRoute,
  signInOnce,
  singleUser,
  type Transport,
  verdict,
} from './runner';
import type { Summary } from './stats';
import {
  defaultVus,
  describeTarget,
  describeUsers,
  effectiveMix,
  isGated,
  isSequential,
  type LoadTarget,
  parseLoadTarget,
} from './target';

const WARMUP_S = 5;
const WARMUP_VUS = 2;
const SINGLE_USER_COUNT = 15;
/** The informational single-user line: one session, sequential requests, median per route. */
const SINGLE_USER_ROUTES: readonly SingleUserRoute[] = [
  { label: 'health', method: 'GET', path: '/api/health' },
  { label: 'contacts list', method: 'GET', path: '/api/v1/contacts?limit=50' },
  { label: 'contact detail', method: 'GET', path: '/api/v1/contacts/{ids.heavy}' },
];

function intFlag(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
  return n;
}

const f1 = (n: number) => n.toFixed(1);

function row(label: string, s: Summary): string {
  return `| ${label} | ${s.count} | ${s.errors} | ${f1(s.p50)} | ${f1(s.p95)} | ${f1(s.p99)} | ${f1(s.max)} | ${f1(s.rps)} |`;
}

function table(title: string, entries: Record<string, Summary>): string[] {
  return [
    `## ${title}`,
    '',
    '| Name | Count | Errors | p50 ms | p95 ms | p99 ms | max ms | req/s |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(entries)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, s]) => row(k, s)),
    '',
  ];
}

export type LoadReportMeta = {
  date: string;
  database: string;
  scale: string;
  postgres?: string;
  /** Defaults to inprocess. */
  target?: LoadTarget;
  singleUser?: SingleUserResult[];
  /** Free text, for example the background load during the run. */
  note?: string;
};

function singleUserLine(results: SingleUserResult[]): string {
  const parts = results.map((r) => `${r.label} ${f1(r.medianMs)} ms`);
  return `- Single user: median of ${SINGLE_USER_COUNT} sequential requests on one session, ${parts.join(', ')}`;
}

/** Renders the report; `result` is null when the run never produced one (startup failure). */
export function renderLoadReport(
  result: LoadResult | null,
  problems: string[],
  meta: LoadReportMeta,
  vus = 0,
): string {
  const target = meta.target ?? { kind: 'inprocess' };
  const gated = isGated(target);
  const pass = gated ? 'PASS' : 'PASS (informational, no gate)';
  const header = [
    `# Load report ${meta.date}`,
    '',
    `Overall: ${problems.length === 0 ? pass : `**FAIL** (${problems.length} problems)`}`,
    '',
    describeTarget(target),
    describeUsers(target, result?.vus ?? vus),
    `- Database: ${meta.database} (${meta.scale})`,
    result
      ? `- Load: ${result.vus} virtual users, ${result.durationS} s (ran ${f1(result.elapsedS)} s), ${WARMUP_S} s warm-up at ${WARMUP_VUS} users not recorded`
      : `- Load: not run (${vus} virtual users requested)`,
    gated
      ? `- Budget: p95 at most ${P95_BUDGET_MS} ms for list, search, detail and timeline requests; no errors`
      : '- Budget: none (informational, no gate); the run fails only on errors',
    ...(meta.singleUser ? [singleUserLine(meta.singleUser)] : []),
    `- Machine: ${machineSummary(meta.postgres)}`,
    ...(meta.note ? [`- Note: ${meta.note}`] : []),
    '',
    ...problems.map((p) => `- **FAIL**: ${p}`),
    ...(problems.length > 0 ? [''] : []),
  ];
  const body = result
    ? [...table('Requests', result.requests), ...table('Scenarios (wall time)', result.scenarios)]
    : [];
  return `${[...header, ...body].join('\n')}\n`;
}

/** Contact and timeline row counts of organization A, as a short scale description. */
async function describeScale(adminUrl: string, orgId: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ c: string; t: string }>(
      `select (select count(*) from contact where organization_id = $1)::text as c,
              (select count(*) from timeline_event where organization_id = $1)::text as t`,
      [orgId],
    );
    return `${rows[0]?.c} contacts, ${rows[0]?.t} timeline events in organization A`;
  } catch {
    return 'row counts unavailable';
  } finally {
    await client.end().catch(() => undefined);
  }
}

type RunPlan = {
  mix: Mix;
  fixtures: Fixtures;
  vus: number;
  durationS: number;
  sequential: boolean;
};
type RunOutput = { result: LoadResult; singleUser?: SingleUserResult[] };

async function warmUpAndLoad(transport: Transport, plan: RunPlan): Promise<LoadResult> {
  const common = {
    transport,
    mix: plan.mix,
    fixtures: plan.fixtures,
    sequential: plan.sequential,
  };
  out(`warm-up ${WARMUP_S} s at ${WARMUP_VUS} users`);
  await runLoad({ ...common, vus: WARMUP_VUS, durationS: WARMUP_S });
  out(`load ${plan.vus} users for up to ${plan.durationS} s`);
  return runLoad({ ...common, vus: plan.vus, durationS: plan.durationS });
}

async function runInProcess(target: PerfTarget, plan: RunPlan): Promise<RunOutput> {
  // Imported here so the report renderer stays importable without loading the API.
  const { createInProcessApi } = await import('../app-harness');
  const api = createInProcessApi(target);
  try {
    return { result: await warmUpAndLoad(inProcessTransport(api), plan) };
  } finally {
    await api.flush();
  }
}

async function runWrangler(target: PerfTarget, plan: RunPlan): Promise<RunOutput> {
  const removeHandlers = stopOnSignals();
  let servers: Awaited<ReturnType<typeof startServers>> | undefined;
  try {
    servers = await startServers({ target, web: false });
    const transport = httpTransport(servers.apiOrigin, servers.webOrigin);
    const result = await warmUpAndLoad(transport, plan);
    out(`single user: ${SINGLE_USER_COUNT} sequential requests per route`);
    const { email, password } = plan.fixtures.ownerA;
    const cookie = await transport.signIn(email, password);
    const routes = SINGLE_USER_ROUTES.map((r) => ({
      ...r,
      path: fillTemplate(r.path, plan.fixtures),
    }));
    return {
      result,
      singleUser: await singleUser(transport, cookie, routes, SINGLE_USER_COUNT),
    };
  } finally {
    await servers?.stop();
    removeHandlers();
  }
}

async function runTarget(target: PerfTarget, load: LoadTarget, plan: RunPlan): Promise<RunOutput> {
  switch (load.kind) {
    case 'inprocess':
      return runInProcess(target, plan);
    case 'wrangler':
      return runWrangler(target, plan);
    case 'remote':
      return {
        result: await warmUpAndLoad(
          signInOnce(httpTransport(load.apiOrigin, load.webOrigin)),
          plan,
        ),
      };
  }
}

function problemsOf(output: RunOutput, load: LoadTarget): string[] {
  const singleUserErrors = (output.singleUser ?? [])
    .filter((r) => r.errors > 0)
    .map((r) => `single user ${r.label}: ${r.errors} errors`);
  return [...verdict(output.result, { gate: isGated(load) }), ...singleUserErrors];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = resolveTarget(argv, process.env);
  if (!target.ok) fail(target.error);
  const load = parseLoadTarget(argv, target.value.force);
  if (!load.ok) fail(load.error);
  let fixtures: Fixtures;
  try {
    fixtures = loadFixtures(target.value.database);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const fullMix = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'perf', 'load', 'mix.json'), 'utf8'),
  ) as Mix;
  const mix = effectiveMix(fullMix, load.value);
  const mixProblem = preflightMix(mix, fixtures);
  if (mixProblem) fail(mixProblem);
  const vus = intFlag(argv, '--vus', defaultVus(load.value));
  const durationS = intFlag(argv, '--duration', 30);
  const date = new Date().toISOString().slice(0, 10);
  const suffix = load.value.kind === 'inprocess' ? '' : `-${load.value.kind}`;
  const file = resolve(REPO_ROOT, flagValue(argv, '--out') ?? `docs/perf/${date}-load${suffix}.md`);
  const note = flagValue(argv, '--note');

  const meta: LoadReportMeta = {
    date,
    database: fixtures.database,
    scale: await describeScale(target.value.adminUrl, fixtures.ownerA.orgId),
    postgres: await postgresVersion(target.value.adminUrl).catch(() => undefined),
    target: load.value,
    ...(note ? { note } : {}),
  };
  const finish = (output: RunOutput | null, problems: string[]): never => {
    const full = output?.singleUser ? { ...meta, singleUser: output.singleUser } : meta;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderLoadReport(output?.result ?? null, problems, full, vus));
    for (const p of problems) out(`FAIL ${p}`);
    out(problems.length === 0 ? 'PASS load' : 'FAIL load');
    process.exit(problems.length === 0 ? 0 : 1);
  };

  let output: RunOutput;
  try {
    const sequential = isSequential(load.value);
    output = await runTarget(target.value, load.value, {
      mix,
      fixtures,
      vus,
      durationS,
      sequential,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return finish(null, [`run aborted: ${reason.split(/\r?\n/)[0]}`]);
  }
  finish(output, problemsOf(output, load.value));
}

// Run only as the entry point, so tests can import renderLoadReport.
if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
}

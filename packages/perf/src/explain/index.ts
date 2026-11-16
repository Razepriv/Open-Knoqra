// `pnpm perf:explain --database <name> [--out <file>]`
// Runs the registry's real API requests in-process, captures the SQL, and replays each statement
// under EXPLAIN (ANALYZE, BUFFERS) as knoqra_app. Exits 1 on any violation or budget overrun.
import os from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { createInProcessApi } from '../app-harness';
import { captureQueries } from '../capture';
import {
  assertAppRole,
  flagValue,
  isEntryPoint,
  loadFixtures,
  type PerfTarget,
  REPO_ROOT,
  resolveTarget,
} from '../config';
import { fail, out } from '../out';
import type { Fixtures } from '../seed/fixtures';
import { ORG_A_ID, OWNER_A_EMAIL, PASSWORD } from '../seed/fixtures';
import { analyzePlan, collectIds } from './analyze';
import { EXPLAIN_CASES, resolveCase } from './registry';
import { contactsInOrg, largeTables, postgresVersion, replay } from './replay';
import { type CaseResult, caseProblems, writeReport } from './report';

const CONTACT_ID_KEYS = new Set(['contactId']);

async function isolationProblems(appUrl: string, json: unknown): Promise<string[]> {
  const found = collectIds(json);
  const problems = found
    .filter((f) => f.key === 'organizationId' && f.value !== ORG_A_ID)
    .map((f) => `isolation: foreign organizationId ${f.value}`);
  // Every contactId by key, plus every ct_ id under `id`.
  const contactIds = [
    ...new Set(
      found
        .filter((f) => CONTACT_ID_KEYS.has(f.key) || f.value.startsWith('ct_'))
        .map((f) => f.value),
    ),
  ];
  const owned = await contactsInOrg(appUrl, ORG_A_ID, contactIds);
  for (const id of contactIds) if (!owned.has(id)) problems.push(`isolation: ${id} not in org A`);
  return problems;
}

async function countRows(adminUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ c: string; t: string }>(
      'select (select count(*) from contact)::text as c, (select count(*) from timeline_event)::text as t',
    );
    return `${rows[0]?.c} contacts, ${rows[0]?.t} timeline events`;
  } finally {
    await client.end();
  }
}

/** Signs in and runs every registry case; pushes into `results` so a failure keeps the partial list. */
async function runCases(
  target: PerfTarget,
  fixtures: Fixtures,
  results: CaseResult[],
): Promise<void> {
  const { adminUrl, appUrl } = target;
  const large = await largeTables(adminUrl);
  const api = createInProcessApi(target);
  const cookie = await api.signIn(OWNER_A_EMAIL, PASSWORD);
  for (const c of EXPLAIN_CASES) {
    const { path, body } = resolveCase(c, fixtures);
    const { result: response, statements } = await captureQueries(async () => {
      const r = await api.request(c.method, path, { body, cookie });
      await api.flush();
      return r;
    });
    const replayed = await replay(appUrl, statements, c.mutates === true);
    const reports = replayed.map((r) => ({
      sql: r.sql,
      buffers: r.buffers,
      ...(r.plan === null
        ? {
            executionMs: 0,
            planningMs: 0,
            seqScans: [],
            violations: [],
            nodes: [`not replayed: ${r.note ?? 'no plan'}`],
          }
        : analyzePlan(r.plan, large, c.allowSeqScan)),
    }));
    const ok2xx = response.status >= 200 && response.status < 300;
    const isolation = ok2xx ? await isolationProblems(appUrl, response.json) : [];
    const base = {
      name: c.name,
      milestone: c.milestone,
      budgetMs: c.budgetMs,
      httpStatus: response.status,
      statements: reports,
      notes: replayed.flatMap((r) => (r.note ? [r.note] : [])),
      ...(c.allowOverBudget ? { overBudgetAllowed: c.allowOverBudget } : {}),
    };
    const result = { ...base, problems: caseProblems(base, isolation) };
    results.push(result);
    out(`${result.problems.length === 0 ? 'PASS' : 'FAIL'} ${c.name}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = resolveTarget(argv, process.env);
  if (!target.ok) fail(target.error);
  const { adminUrl, appUrl, database } = target.value;
  await assertAppRole(appUrl);

  let fixtures: Fixtures;
  try {
    fixtures = loadFixtures(database);
  } catch (error) {
    return fail(firstLine(error));
  }

  const date = new Date().toISOString().slice(0, 10);
  const file = resolve(REPO_ROOT, flagValue(argv, '--out') ?? `docs/perf/${date}-explain.md`);
  const note = flagValue(argv, '--note');

  const results: CaseResult[] = [];
  let failure: string | undefined;
  try {
    await runCases(target.value, fixtures, results);
  } catch (error) {
    failure = `run aborted: ${firstLine(error)}`;
  }
  writeReport(file, results, {
    date,
    database,
    platform: os.platform(),
    cpus: os.cpus().length,
    node: process.versions.node,
    postgres: await postgresVersion(adminUrl).catch(() => 'unknown'),
    rows: await countRows(adminUrl).catch(() => 'row counts unavailable'),
    warnings: note ? [note] : [],
    failure,
  });
  if (failure !== undefined) {
    process.stderr.write(`FAIL ${failure}\n`);
    process.exit(1);
  }
  const failed = results.filter((r) => r.problems.length > 0);
  out(`${results.length - failed.length}/${results.length} cases passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/)[0] ?? text;
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => fail(firstLine(error)));
}

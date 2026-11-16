// `pnpm perf:seed --database <name> [--reset] [--scale <0..1>] [--seed <n>]`
// Deterministic bulk seed: two organizations, then an isolation check through the real API.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from '@knoqra/db/migrate';
import pg from 'pg';
import { createInProcessApi, type InProcessApi } from '../app-harness';
import {
  assertAppRole,
  FIXTURES_PATH,
  flagValue,
  isEntryPoint,
  type PerfTarget,
  resolveTarget,
} from '../config';
import { fail, out } from '../out';
import {
  buildFixtures,
  CONTACTS_DEEP_OFFSET,
  deepOffset,
  type Fixtures,
  ORG_A_ID,
  ORG_B_ID,
  OWNER_A_EMAIL,
  OWNER_B_EMAIL,
  PASSWORD,
  planSeed,
  type SeedPlan,
  TIMELINE_DEEP_OFFSET,
} from './fixtures';
import { bulkLoad, type OrgLoadCounts } from './load';
import { queryPhase1 } from './phase1-fixtures';
import {
  canReset,
  describeReset,
  EMPTINESS_SQL,
  isPopulated,
  parseCounts,
  RESET_TRUNCATE_SQL,
} from './reset';

function parseNumber(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${name} must be a number, got "${raw}"`);
  return value;
}

/** Foreign keys the pin repoints to the new organization row. */
const REPOINTED: readonly string[] = [
  'member.organization_id',
  'invitation.organization_id',
  'session.active_organization_id',
];

export type OrgReference = { table: string; column: string };

/** References to organization that the pin does not repoint, so each must hold no rows. */
export function unrepointedReferences(refs: readonly OrgReference[]): OrgReference[] {
  return refs.filter(
    (r) => !REPOINTED.includes(`${r.table.replaceAll('"', '')}.${r.column.replaceAll('"', '')}`),
  );
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Throws, naming the table, when a non-repointed reference still holds rows for `oldId`. */
async function assertNoOrphanedRows(client: pg.Client, oldId: string): Promise<void> {
  const { rows } = await client.query<{ tbl: string; col: string }>(
    `select c.conrelid::regclass::text as tbl, a.attname as col
       from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confrelid = 'organization'::regclass`,
  );
  const others = unrepointedReferences(rows.map((r) => ({ table: r.tbl, column: r.col })));
  for (const ref of others) {
    const { rows: found } = await client.query<{ n: string }>(
      `select count(*)::text as n from ${ref.table} where ${quoteIdent(ref.column)} = $1`,
      [oldId],
    );
    if (Number(found[0]?.n ?? 0) > 0) {
      throw new Error(
        `pinOrgId: ${ref.table}.${ref.column} still references ${oldId}; deleting it would drop those rows`,
      );
    }
  }
}

/** Gives a sign-up's personal workspace a fixed id, so fixtures reproduce byte for byte. */
async function pinOrgId(client: pg.Client, email: string, newId: string): Promise<void> {
  const found = await client.query<{ id: string; slug: string }>(
    `select o.id, o.slug from organization o
       join member m on m.organization_id = o.id join "user" u on u.id = m.user_id
      where u.email = $1`,
    [email],
  );
  const org = found.rows[0];
  if (!org) throw new Error(`no workspace found for ${email}`);
  await client.query('BEGIN');
  try {
    await client.query(
      `insert into organization (id, name, slug, logo, created_at, metadata)
       select $2, name, 'pinning-' || id, logo, created_at, metadata from organization where id = $1`,
      [org.id, newId],
    );
    await client.query('update member set organization_id = $2 where organization_id = $1', [
      org.id,
      newId,
    ]);
    await client.query('update invitation set organization_id = $2 where organization_id = $1', [
      org.id,
      newId,
    ]);
    await client.query(
      'update session set active_organization_id = $2 where active_organization_id = $1',
      [org.id, newId],
    );
    await assertNoOrphanedRows(client, org.id);
    await client.query('delete from organization where id = $1', [org.id]);
    await client.query('update organization set slug = $2 where id = $1', [newId, org.slug]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function userIdOf(client: pg.Client, email: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select id from "user" where email = $1', [
    email,
  ]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`no user for ${email}`);
  return id;
}

function phase1Summary(counts: OrgLoadCounts): string {
  return Object.entries(counts.phase1)
    .map(([table, n]) => `${table} ${n}`)
    .join(', ');
}

async function resetOrAssertEmpty(
  client: pg.Client,
  target: PerfTarget,
  reset: boolean,
): Promise<void> {
  const { rows } = await client.query<Record<string, string>>(EMPTINESS_SQL);
  const counts = parseCounts(rows[0]);
  if (isPopulated(counts) && !reset) fail('database is not empty; pass --reset');
  if (reset) {
    out(describeReset(target.database, counts));
    await client.query(RESET_TRUNCATE_SQL);
  }
}

async function queryDeepCursors(client: pg.Client, plan: SeedPlan) {
  await client.query('BEGIN');
  try {
    await client.query(`select set_config('app.org_id', $1, true)`, [ORG_A_ID]);
    // The owner connection bypasses RLS, so each query names organization A explicitly.
    const contacts = await client.query<{ name: string; id: string }>(
      `select lower(display_name) as name, id from contact
        where organization_id = $2 and archived_at is null
        order by lower(display_name), id offset $1 limit 1`,
      [
        deepOffset(CONTACTS_DEEP_OFFSET, plan.scale, plan.orgA.contacts.kinds.active.length),
        ORG_A_ID,
      ],
    );
    const events = await client.query<{ at: string; id: string }>(
      `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, id
         from timeline_event where contact_id = $1
        order by occurred_at desc, id desc offset $2 limit 1`,
      [plan.orgA.heavyId, deepOffset(TIMELINE_DEEP_OFFSET, plan.scale, plan.counts.heavyTimeline)],
    );
    const phase1 = await queryPhase1(client, ORG_A_ID, OWNER_A_EMAIL, plan.scale);
    await client.query('COMMIT');
    const c = contacts.rows[0];
    const e = events.rows[0];
    if (!c || !e) throw new Error('no rows found for the deep cursors');
    return {
      contactsDeep: { name: c.name, id: c.id },
      timelineDeep: { occurredAt: e.at, id: e.id },
      phase1,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Owner B pages through every contact: all must be B's, and the total must match. */
async function isolationCheck(
  api: InProcessApi,
  plan: SeedPlan,
  aContactId: string,
): Promise<number> {
  const cookie = await api.signIn(OWNER_B_EMAIL, PASSWORD);
  const expected = plan.orgB.contacts.rows.filter(
    (r) => r.archived_at === null && r.merged_into_id === null,
  ).length;
  let seen = 0;
  let cursor: string | null = null;
  do {
    const query = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await api.request('GET', `/api/v1/contacts?${query}`, { cookie });
    if (r.status !== 200) throw new Error(`isolation check: list returned ${r.status}`);
    const data =
      (r.json as { data?: { items: { organizationId: string }[]; nextCursor: string | null } })
        .data ?? (r.json as { items: { organizationId: string }[]; nextCursor: string | null });
    for (const item of data.items) {
      if (item.organizationId !== ORG_B_ID) {
        throw new Error(`isolation check: saw a contact of ${item.organizationId}`);
      }
    }
    seen += data.items.length;
    cursor = data.nextCursor;
  } while (cursor);
  if (seen !== expected)
    throw new Error(`isolation check: saw ${seen} contacts, expected ${expected}`);
  const crossRead = await api.request('GET', `/api/v1/contacts/${aContactId}`, { cookie });
  if (crossRead.status !== 404) {
    throw new Error(`isolation check: org B read an org A contact (status ${crossRead.status})`);
  }
  return seen;
}

/** Writes `.perf/fixtures.json` and returns the text written. */
export function writeFixtures(fixtures: Fixtures, path: string = FIXTURES_PATH): string {
  const text = `${JSON.stringify(fixtures, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  out('fixtures written to .perf/fixtures.json');
  return text;
}

/** Recomputes the fixtures file from an already-seeded database: no migrate, reset or load. */
async function writeFixturesOnly(target: PerfTarget, plan: SeedPlan): Promise<void> {
  const owner = new pg.Client({ connectionString: target.adminUrl });
  await owner.connect();
  try {
    const deep = await queryDeepCursors(owner, plan);
    writeFixtures(buildFixtures(plan, { database: target.database, ...deep }));
  } finally {
    await owner.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const resolved = resolveTarget(argv, process.env);
  if (!resolved.ok) fail(resolved.error);
  const target: PerfTarget = resolved.value;
  const reset = argv.includes('--reset');
  if (reset && !canReset(target.database)) {
    fail(
      `--reset refuses database "${target.database}": the name must contain "perf" (--force does not apply)`,
    );
  }
  const scale = parseNumber(argv, '--scale', 1);
  if (!(scale > 0 && scale <= 1)) fail('--scale must be in (0, 1]');
  const seed = parseNumber(argv, '--seed', 42);
  const started = Date.now();

  if (argv.includes('--fixtures-only')) {
    await writeFixturesOnly(target, planSeed(seed, scale));
    return;
  }
  out(`target database: ${target.database}, scale ${scale}, seed ${seed}`);
  await assertAppRole(target.appUrl);
  await runMigrations(target.adminUrl);

  const owner = new pg.Client({ connectionString: target.adminUrl });
  await owner.connect();
  try {
    await resetOrAssertEmpty(owner, target, reset);
    const api = createInProcessApi(target);
    out('signing up owners');
    await api.signUp('Perf Owner A', OWNER_A_EMAIL, PASSWORD);
    await api.signUp('Perf Owner B', OWNER_B_EMAIL, PASSWORD);
    await pinOrgId(owner, OWNER_A_EMAIL, ORG_A_ID);
    await pinOrgId(owner, OWNER_B_EMAIL, ORG_B_ID);

    const plan = planSeed(seed, scale);
    const loaded = await bulkLoad(target.adminUrl, plan, {
      a: await userIdOf(owner, OWNER_A_EMAIL),
      b: await userIdOf(owner, OWNER_B_EMAIL),
    });
    const deep = await queryDeepCursors(owner, plan);
    const fixtures = buildFixtures(plan, { database: target.database, ...deep });
    writeFixtures(fixtures);

    out(
      `org A: ${loaded.orgA.contacts} contacts, ${loaded.orgA.consent} consent events, ` +
        `${loaded.orgA.timeline} timeline events, ${loaded.orgA.dismissals} dismissals`,
    );
    out(
      `org B: ${loaded.orgB.contacts} contacts, ${loaded.orgB.consent} consent events, ` +
        `${loaded.orgB.timeline} timeline events`,
    );
    out(`org A phase 1: ${phase1Summary(loaded.orgA)}`);
    out(`org B phase 1: ${phase1Summary(loaded.orgB)}`);
    out(`bulk load ${loaded.seconds}s`);

    const seen = await isolationCheck(api, plan, fixtures.ids.first);
    out(`isolation check passed (org B saw ${seen} contacts, all its own)`);
    out(`total wall time ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await owner.end();
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error: unknown) => {
    fail(
      `perf:seed failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  });
}

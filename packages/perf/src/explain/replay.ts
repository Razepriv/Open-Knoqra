// Replays captured statements under EXPLAIN (ANALYZE, BUFFERS) as knoqra_app inside a rolled-back
// transaction, so RLS applies exactly as it did for the API.
import pg from 'pg';
import type { CapturedStatement } from '../capture';

export type StatementResult = {
  sql: string;
  plan: unknown | null;
  buffers: string;
  /** Set when a write could not be replayed (for example its row already exists after R5). */
  note?: string;
};

const CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;
const EXPLAINABLE = /^\s*(select|insert|update|delete|with)\b/i;
const SET_CONFIG = /^\s*select\s+set_config\s*\(/i;

/** True for transaction control statements the replay supplies itself. */
export function isControlStatement(text: string): boolean {
  return CONTROL.test(text);
}

function sharedBuffers(plan: unknown): string {
  const root = (Array.isArray(plan) ? plan[0] : plan) as { Plan?: Record<string, unknown> };
  const p = root?.Plan ?? {};
  const get = (k: string) => Number(p[k] ?? 0);
  return `hit=${get('Shared Hit Blocks')} read=${get('Shared Read Blocks')}`;
}

const DML = /^\s*(insert|update|delete)\b/i;
const UNIQUE_VIOLATION = '23505';

/**
 * Only a unique-key conflict from a plain INSERT, UPDATE or DELETE of a case that mutates is
 * tolerated: after R5 the replay re-inserts rows the request already committed.
 */
export function isTolerableConflict(text: string, code: unknown, mutates: boolean): boolean {
  return mutates && code === UNIQUE_VIOLATION && DML.test(text);
}

function describeFailure(error: unknown, statement: CapturedStatement): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const head = statement.text.replace(/\s+/g, ' ').slice(0, 120);
  return new Error(`replay failed (${detail}) for: ${head} [${statement.values.length} values]`);
}

async function runStatement(
  client: pg.Client,
  statement: CapturedStatement,
): Promise<StatementResult | null> {
  if (SET_CONFIG.test(statement.text) || !EXPLAINABLE.test(statement.text)) {
    await client.query(statement.text, statement.values);
    return null;
  }
  const res = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
    statement.values,
  );
  const plan = res.rows[0]?.['QUERY PLAN'] ?? null;
  return { sql: statement.text, plan, buffers: sharedBuffers(plan) };
}

/**
 * Replays `statements` in one BEGIN ... ROLLBACK on a knoqra_app connection. `mutates` marks a
 * case whose request committed writes, so unique-key conflicts on re-insert are tolerated.
 */
export async function replay(
  appUrl: string,
  statements: CapturedStatement[],
  mutates = false,
): Promise<StatementResult[]> {
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  const results: StatementResult[] = [];
  try {
    await client.query('BEGIN');
    for (const statement of statements) {
      if (isControlStatement(statement.text)) continue;
      await client.query('SAVEPOINT replay_statement');
      try {
        const result = await runStatement(client, statement);
        if (result) results.push(result);
        await client.query('RELEASE SAVEPOINT replay_statement');
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (!isTolerableConflict(statement.text, code, mutates)) {
          throw describeFailure(error, statement);
        }
        await client.query('ROLLBACK TO SAVEPOINT replay_statement');
        const note = error instanceof Error ? error.message : String(error);
        results.push({ sql: statement.text, plan: null, buffers: '-', note });
      }
    }
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
  return results;
}

/** Relations with reltuples >= 10000, read as the owner role. */
export async function largeTables(adminUrl: string): Promise<Set<string>> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.reltuples >= 10000`,
    );
    return new Set(rows.map((r) => r.relname));
  } finally {
    await client.end();
  }
}

/** The Postgres version number, for the report. */
export async function postgresVersion(adminUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: string }>('select version() as version');
    return /PostgreSQL (\S+)/.exec(rows[0]?.version ?? '')?.[1] ?? 'unknown';
  } finally {
    await client.end();
  }
}

/** Ids of the contacts that belong to org A, among `ids`, as knoqra_app with org A set. */
export async function contactsInOrg(
  appUrl: string,
  orgId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const client = new pg.Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("select set_config('app.org_id', $1, true)", [orgId]);
    const { rows } = await client.query<{ id: string }>(
      'select id from contact where id = any($1)',
      [ids],
    );
    await client.query('ROLLBACK');
    return new Set(rows.map((r) => r.id));
  } finally {
    await client.end();
  }
}

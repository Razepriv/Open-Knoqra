// Column-wise bulk inserts: one `INSERT ... SELECT FROM unnest(...)` statement per batch.
import type pg from 'pg';
import { out } from '../out';

export type Column = { name: string; type: string; expr?: string };

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Inserts `rows` (objects keyed by column name) in one statement using column-wise arrays. */
export async function insertBatch(
  client: pg.Client,
  table: string,
  columns: readonly Column[],
  rows: readonly object[],
): Promise<void> {
  if (rows.length === 0) return;
  const records = rows as readonly Record<string, unknown>[];
  const params = columns.map((c) => records.map((r) => r[c.name] ?? null));
  const sources = columns.map((c, i) => `$${i + 1}::${c.type}[]`).join(', ');
  const aliases = columns.map((c) => quote(c.name)).join(', ');
  const selects = columns.map((c) => c.expr ?? `t.${quote(c.name)}`).join(', ');
  await client.query(
    `INSERT INTO ${quote(table)} (${aliases}) SELECT ${selects} FROM unnest(${sources}) AS t(${aliases})`,
    params,
  );
}

/** Inserts every batch of `stream`, reporting progress every 100,000 rows. */
export async function loadStream(
  client: pg.Client,
  label: string,
  table: string,
  columns: readonly Column[],
  stream: Generator<object[]>,
  expected: number | null,
): Promise<number> {
  let done = 0;
  let nextReport = 0;
  for (const batch of stream) {
    await insertBatch(client, table, columns, batch);
    done += batch.length;
    if (done >= nextReport) {
      out(`  ${label} ${done}${expected === null ? '' : `/${expected}`}`);
      nextReport = done + 100_000;
    }
  }
  if (expected !== null && done !== expected) {
    throw new Error(`${label}: loaded ${done}, expected ${expected}`);
  }
  return done;
}

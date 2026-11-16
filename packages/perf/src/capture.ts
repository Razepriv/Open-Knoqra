// Captures every SQL statement the `pg` driver sends while a function runs, so explain and
// query-count checks see exactly what the API executed.
import { createRequire } from 'node:module';
import type { Client as PgClient } from 'pg';

export type CapturedStatement = { text: string; values: unknown[] };

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;

function pgClientPrototype(): { query: QueryFn } {
  const require = createRequire(import.meta.resolve('@knoqra/db'));
  const { Client } = require('pg') as { Client: typeof PgClient };
  return Client.prototype as unknown as { query: QueryFn };
}

function statementOf(args: unknown[]): CapturedStatement | null {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { text: first, values: Array.isArray(second) ? second : [] };
  }
  if (first && typeof first === 'object' && 'text' in first) {
    const { text, values } = first as { text: unknown; values?: unknown };
    // pg also accepts a config object plus a separate values array (drizzle's pool path).
    const bound = Array.isArray(values) ? values : Array.isArray(second) ? second : [];
    if (typeof text === 'string') return { text, values: bound };
  }
  return null;
}

/** Runs `fn` and returns its result with every statement sent through `pg` Client.query. */
export async function captureQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; statements: CapturedStatement[] }> {
  const proto = pgClientPrototype();
  const original = proto.query;
  const statements: CapturedStatement[] = [];
  proto.query = function (this: unknown, ...args: unknown[]) {
    const statement = statementOf(args);
    if (statement) statements.push(statement);
    return original.apply(this, args);
  };
  try {
    const result = await fn();
    return { result, statements };
  } finally {
    proto.query = original;
  }
}

import { sql } from 'drizzle-orm';
import type { Database, Tx } from './client';

/**
 * Runs `fn` in a transaction scoped to one organization. `app.org_id` is set with
 * `set_config(..., true)`, i.e. transaction-local, so it never leaks to the next transaction on
 * the same pooled connection. Row-level security reads it; an unset or empty value matches no rows.
 *
 * The id is passed to Postgres exactly as given. Blank ids and ids with leading or trailing
 * whitespace are rejected rather than trimmed, so a malformed id can never alias another tenant.
 */
export async function withTenant<T>(
  db: Database,
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (typeof orgId !== 'string' || orgId.trim() === '' || orgId.trim() !== orgId) {
    throw new TypeError(
      'withTenant requires a non-empty organization id without surrounding whitespace',
    );
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

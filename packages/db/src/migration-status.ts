import { sql } from 'drizzle-orm';
import journal from '../migrations/meta/_journal.json';
import type { Database } from './client';

/** Number of migrations bundled with this build (entries in the drizzle journal). */
export const EXPECTED_MIGRATIONS: number = journal.entries.length;

/**
 * How many migrations the connected database has applied, via a SECURITY DEFINER function so the
 * app role never needs access to the owner-only drizzle schema.
 */
export async function migrationStatus(
  db: Database,
): Promise<{ applied: number; expected: number }> {
  const result = await db.execute<{ applied: number }>(
    sql`select applied from public.knoqra_migration_status()`,
  );
  const applied = Number(result.rows[0]?.applied ?? 0);
  return { applied, expected: EXPECTED_MIGRATIONS };
}

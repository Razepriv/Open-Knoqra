import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client';

/** Local docker admin/owner role. Never the runtime connection: superusers bypass RLS. */
export const DEFAULT_MIGRATION_DATABASE_URL = 'postgres://knoqra:knoqra@localhost:54329/knoqra';

/** A migration sequence: drizzle SQL migrations, their tracking table, then an idempotent RLS file. */
interface MigrationSet {
  folder: string;
  table: string;
  rls: string;
}

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

/** The core sequence, tracked in drizzle.__drizzle_migrations as always. */
const CORE: MigrationSet = {
  folder: path('../migrations'),
  table: '__drizzle_migrations',
  rls: path('../sql/rls.sql'),
};

/**
 * Another edition's own tables (KNOQRA Cloud keeps them in `pro/`, which the open-source tree does
 * not have): plain SQL with its own journal and tracking table, applied after the core. Shared
 * tables are never changed there. See EDITIONS.md.
 */
const EDITION: MigrationSet = {
  folder: path('../pro/migrations'),
  table: '__drizzle_migrations_pro',
  rls: path('../pro/sql/rls.sql'),
};

/** The sequences this tree carries, core first. */
export function migrationSets(): MigrationSet[] {
  return existsSync(`${EDITION.folder}/meta/_journal.json`) ? [CORE, EDITION] : [CORE];
}

/**
 * Runs pending drizzle migrations, then (re)applies the RLS file, for each sequence in order. Every
 * step is idempotent. Node-only: not exported from the package entry, which must stay Workers-safe.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, close } = createDb(connectionString);
  try {
    for (const set of migrationSets()) {
      await migrate(db, { migrationsFolder: set.folder, migrationsTable: set.table });
      const rlsSql = await readFile(set.rls, 'utf8');
      await db.execute(sql.raw(rlsSql));
    }
  } finally {
    await close();
  }
}

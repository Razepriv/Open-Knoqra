import { createDb } from '@knoqra/db';
import { runMigrations } from '@knoqra/db/migrate';
import { sql } from 'drizzle-orm';
import { APP_DATABASE_URL, MIGRATION_DATABASE_URL } from './database-urls';

/**
 * The isolation tests only prove something if the Worker connects as a role that row-level
 * security applies to. Fail the run, loudly, if DATABASE_URL points at anything else.
 */
async function assertAppRole(): Promise<void> {
  const { db, close } = createDb(APP_DATABASE_URL);
  try {
    const result = await db.execute<{ user: string; super: boolean; bypass: boolean }>(sql`
      select current_user as "user", rolsuper as "super", rolbypassrls as "bypass"
      from pg_roles where rolname = current_user`);
    const role = result.rows[0];
    if (role?.user !== 'knoqra_app' || role.super || role.bypass) {
      throw new Error(
        `DATABASE_URL must connect as knoqra_app (no SUPERUSER, no BYPASSRLS); got ${JSON.stringify(role)}`,
      );
    }
  } finally {
    await close();
  }
}

/** Runs in Node before the Workers pool starts. */
export default async function setup(): Promise<void> {
  await runMigrations(MIGRATION_DATABASE_URL);
  await assertAppRole();
}

import { DEFAULT_MIGRATION_DATABASE_URL } from '../src/migrate';

const DEFAULT_DATABASE_URL = 'postgres://knoqra_app:knoqra_app@localhost:54329/knoqra';

/** Admin (owner/superuser) URL: migrations, seeding and cleanup only. */
export const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? DEFAULT_MIGRATION_DATABASE_URL;
/** App-role URL (knoqra_app, NOBYPASSRLS): every isolation assertion runs through it. */
export const appUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
export function pgMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

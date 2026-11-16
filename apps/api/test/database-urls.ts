// Node-side settings shared by vitest.config.ts and global-setup.ts. No workspace imports: the
// config loader runs this file with plain Node, which cannot load @knoqra/db's TS sources.

/** Non-superuser app role: the Worker must never connect as a role that bypasses RLS. */
export const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://knoqra_app:knoqra_app@localhost:54329/knoqra';

/** Owner/admin role: migrations, plus test-only fixture surgery. Never used by Worker code. */
export const MIGRATION_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL ?? 'postgres://knoqra:knoqra@localhost:54329/knoqra';

/** Nothing listens on port 1, so every connection attempt fails. */
export const UNREACHABLE_DATABASE_URL = 'postgres://x:x@127.0.0.1:1/x';

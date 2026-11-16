// Postgres helpers for setup and deploy. `pg` is loaded from packages/db (installed by
// `pnpm install`); when it is missing the connection test is skipped with a note.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { APP_ROLE, SetupError } from './settings.mjs';

/** Loads `pg` the way packages/db resolves it, or returns null when it is not installed. */
export function loadPg(root) {
  try {
    return createRequire(join(root, 'packages', 'db', 'package.json'))('pg');
  } catch {
    return null;
  }
}

async function withClient(pg, url, fn) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Postgres access over a loaded `pg` module (or null). */
export function createPostgres(pg) {
  return {
    /** Connects with the owner URL and reports who it is. Never throws. */
    async check(url) {
      if (!pg)
        return { skipped: true, reason: 'pg is not installed yet (run pnpm install first).' };
      try {
        return await withClient(pg, url, async (client) => {
          const { rows } = await client.query(
            `select current_user as "user", current_database() as "database",
                    current_setting('server_version') as "version",
                    current_setting('server_version_num')::int as "num",
                    (select rolcreaterole or rolsuper from pg_roles where rolname = current_user) as "cr"`,
          );
          const row = rows[0];
          return {
            ok: true,
            user: row.user,
            database: row.database,
            version: row.version,
            major: Math.floor(row.num / 10_000),
            canCreateRole: Boolean(row.cr),
          };
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    /**
     * Creates the app's login role (NOSUPERUSER NOBYPASSRLS) or updates its password, then refuses
     * a role that bypasses row-level security.
     */
    async ensureAppRole(ownerUrl, password) {
      if (!pg) throw new SetupError('pg is not installed. Run pnpm install first.');
      if (!/^[0-9a-f]{16,}$/.test(password)) {
        throw new SetupError('KNOQRA_APP_DB_PASSWORD must be hex. Delete it and run setup again.');
      }
      return withClient(pg, ownerUrl, async (client) => {
        const found = await client.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
        const exists = found.rowCount > 0;
        // DDL takes no parameters; the password is checked to be hex above, so quoting is safe.
        if (exists) await client.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password}'`);
        else {
          await client.query(
            `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
          );
        }
        const { rows } = await client.query(
          'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
          [APP_ROLE],
        );
        if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
          throw new SetupError(
            `${APP_ROLE} bypasses row-level security. Drop the role (or recreate it with NOSUPERUSER NOBYPASSRLS) and run pnpm knoqra deploy db again.`,
          );
        }
        return { created: !exists };
      });
    },
  };
}

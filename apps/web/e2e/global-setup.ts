import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMasterKey, migrationUrlFor, parseDevVars } from './dev-vars';
import { WEB_ORIGIN } from './ports';

/** The docker-compose owner role (see docker-compose.yml): local development only. */
const LOCAL_ADMIN_URL = 'postgres://knoqra:knoqra@localhost:54329/knoqra';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const devVars = fileURLToPath(new URL('../../api/.dev.vars', import.meta.url));

/** Runs once before the suite: the API needs its local secrets and a migrated database. */
export default function globalSetup(): void {
  if (!existsSync(devVars)) {
    throw new Error(
      'apps/api/.dev.vars is missing, so `wrangler dev` has no auth secret. ' +
        'Copy apps/api/.dev.vars.example to apps/api/.dev.vars, set BETTER_AUTH_SECRET, and run the E2E again.',
    );
  }
  const vars = parseDevVars(readFileSync(devVars, 'utf8'));
  if (vars.BETTER_AUTH_URL !== WEB_ORIGIN) {
    throw new Error(
      `apps/api/.dev.vars must set BETTER_AUTH_URL=${WEB_ORIGIN} (the Vite origin that proxies /api).`,
    );
  }
  for (const key of ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'FAKE_WEBHOOK_SECRET']) {
    if (!vars[key]) throw new Error(`apps/api/.dev.vars: ${key} is missing or empty.`);
  }
  // Without it every Telnyx connection save answers 503, and the voice, setup and numbers specs
  // time out waiting for a saved key instead of saying why.
  if (!isMasterKey(vars.CREDENTIALS_MASTER_KEY)) {
    throw new Error(
      'apps/api/.dev.vars: CREDENTIALS_MASTER_KEY must be base64 of 32 random bytes. ' +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  // Migrate the database this API will use, not the migrate script's default (`knoqra`): with
  // parallel worktrees, each on its own database, the default would land one branch's schema in
  // another's database. An explicit MIGRATION_DATABASE_URL still wins.
  const migrationUrl =
    process.env.MIGRATION_DATABASE_URL ??
    // Checked non-empty above.
    migrationUrlFor(vars.DATABASE_URL ?? '', LOCAL_ADMIN_URL);
  // One command string: Windows needs a shell to find pnpm.cmd.
  const result = spawnSync('pnpm --filter @knoqra/db migrate', {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, MIGRATION_DATABASE_URL: migrationUrl },
  });
  if (result.status !== 0) {
    throw new Error(
      'Database migration failed. Is Postgres running? Start it with `docker compose up -d`.',
    );
  }
}

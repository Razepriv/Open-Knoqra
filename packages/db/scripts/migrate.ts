import { DEFAULT_MIGRATION_DATABASE_URL, runMigrations } from '../src/migrate';

const url = process.env.MIGRATION_DATABASE_URL ?? DEFAULT_MIGRATION_DATABASE_URL;

try {
  await runMigrations(url);
  process.stdout.write('migrate: drizzle migrations and sql/rls.sql applied\n');
} catch (error) {
  process.stderr.write(
    `migrate: failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  cronRun,
  EXPECTED_MIGRATIONS,
  migrationStatus,
  user,
  userPrefs,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;
const TEST_USER = 'user_obs_schema_test';
const CRON_NAME = 'obs-schema-test';

beforeAll(async () => {
  await runMigrations(migrationUrl);
  await admin.db.delete(user).where(eq(user.id, TEST_USER));
  await admin.db.delete(cronRun).where(eq(cronRun.name, CRON_NAME));
});

afterAll(async () => {
  await admin.db.delete(user).where(eq(user.id, TEST_USER));
  await admin.db.delete(cronRun).where(eq(cronRun.name, CRON_NAME));
  await admin.close();
  await app.close();
});

describe('migrationStatus', () => {
  it('reports every bundled migration as applied to the app role', async () => {
    const status = await migrationStatus(db);
    expect(status.expected).toBe(EXPECTED_MIGRATIONS);
    expect(status.applied).toBe(EXPECTED_MIGRATIONS);
  });

  it('grants EXECUTE on knoqra_migration_status() to knoqra_app only, never PUBLIC', async () => {
    const fn = 'public.knoqra_migration_status()';
    const result = await admin.db.execute<{ public_can: boolean; app_can: boolean }>(
      sql`select has_function_privilege('public', ${fn}::text, 'EXECUTE') as public_can,
                 has_function_privilege('knoqra_app', ${fn}::text, 'EXECUTE') as app_can`,
    );
    expect(result.rows[0]).toEqual({ public_can: false, app_can: true });
    const grantees = await admin.db.execute<{ grantee: string }>(
      sql`select grantee from information_schema.routine_privileges
          where routine_schema = 'public' and routine_name = 'knoqra_migration_status'
            and privilege_type = 'EXECUTE'`,
    );
    expect(grantees.rows.map((row) => row.grantee)).not.toContain('PUBLIC');
  });

  it('keeps the drizzle schema owner-only for the app role', async () => {
    await expect(db.execute(sql`select * from drizzle.__drizzle_migrations`)).rejects.toSatisfy(
      (e) => pgMessage(e).includes('permission denied'),
    );
  });
});

describe('cron_run', () => {
  it('supports insert, upsert and read', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    await db.insert(cronRun).values({ name: CRON_NAME, lastStartedAt: t0, lastStatus: 'running' });
    await db
      .insert(cronRun)
      .values({ name: CRON_NAME, lastStartedAt: t0, lastStatus: 'running' })
      .onConflictDoUpdate({
        target: cronRun.name,
        set: { lastStatus: 'ok', lastFinishedAt: t0, lastDurationMs: 42 },
      });
    const [row] = await db.select().from(cronRun).where(eq(cronRun.name, CRON_NAME));
    expect(row).toMatchObject({ lastStatus: 'ok', lastDurationMs: 42 });
  });

  it('rejects an unknown status', async () => {
    await expect(
      db.execute(
        sql`insert into cron_run (name, last_started_at, last_status) values ('obs-bogus', now(), 'bogus')`,
      ),
    ).rejects.toSatisfy((e) => pgMessage(e).includes('cron_run_last_status_check'));
  });
});

describe('user_prefs.analytics_consent', () => {
  it('defaults to false', async () => {
    await admin.db
      .insert(user)
      .values({ id: TEST_USER, name: 'Obs', email: 'obs-schema@example.test' });
    await db.insert(userPrefs).values({ userId: TEST_USER });
    const [row] = await db.select().from(userPrefs).where(eq(userPrefs.userId, TEST_USER));
    expect(row?.analyticsConsent).toBe(false);
  });
});

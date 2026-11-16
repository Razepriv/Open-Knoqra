import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, instanceLicense } from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

beforeAll(async () => {
  await runMigrations(migrationUrl);
});

beforeEach(async () => {
  await admin.db.execute(sql`truncate table instance_license`);
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('instance_license', () => {
  it('instance_license holds one row, which the app role may write but not delete', async () => {
    await db.insert(instanceLicense).values({ licenseKey: 'k1', updatedBy: 'user_1' });
    await db
      .insert(instanceLicense)
      .values({ licenseKey: 'k2', updatedBy: 'user_2' })
      .onConflictDoUpdate({ target: instanceLicense.id, set: { licenseKey: 'k2' } });
    const rows = await db.select().from(instanceLicense);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.licenseKey).toBe('k2');
    const second = db.insert(instanceLicense).values({ id: 2, licenseKey: 'k3', updatedBy: 'u' });
    await expect(second.catch(pgMessage)).resolves.toMatch(/instance_license_single_row/);
    const del = db.delete(instanceLicense);
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });
});

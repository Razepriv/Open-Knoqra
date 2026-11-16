import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Contact,
  contact,
  createDb,
  notification,
  organization,
  ottoDraft,
  task,
  usageEvent,
  user,
  userTodayPrefs,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

const M5_TABLES = ['notification', 'otto_draft', 'task', 'usage_event'];
const USER_ID = 'user_m5_1';

async function addContact(orgId: string, displayName: string, phoneE164: string): Promise<Contact> {
  const [row] = await withTenant(db, orgId, (tx) =>
    tx.insert(contact).values({ organizationId: orgId, displayName, phoneE164 }).returning(),
  );
  if (!row) throw new Error('insert returned no row');
  return row;
}

beforeAll(async () => {
  await runMigrations(migrationUrl);
  const now = new Date();
  await admin.db
    .insert(organization)
    .values([
      { id: 'org_a', name: 'Org A', slug: 'org-a', createdAt: now },
      { id: 'org_b', name: 'Org B', slug: 'org-b', createdAt: now },
    ])
    .onConflictDoNothing();
  await admin.db
    .insert(user)
    .values({ id: USER_ID, name: 'Pat', email: 'pat-m5@example.test' })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await admin.db.execute(
    sql`truncate table contact, task, notification, otto_draft, usage_event, user_today_prefs cascade`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

const newTask = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  ownerUserId: USER_ID,
  title: 'Call back',
  ...over,
});
const newNotification = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  userId: USER_ID,
  kind: 'system' as const,
  title: 'Hello',
  dedupeKey: 'k1',
  ...over,
});
const newDraft = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  userId: USER_ID,
  kind: 'draft' as const,
  text: 'Hi there',
  provider: 'stub',
  inputTokens: 1,
  outputTokens: 2,
  ...over,
});
const newUsage = (orgId: string, over: Record<string, unknown> = {}) => ({
  organizationId: orgId,
  service: 'ai' as const,
  quantity: 3,
  unit: 'token',
  provider: 'stub',
  idempotencyKey: 'u1',
  ...over,
});

const tables = [
  { name: 'task', table: task, values: newTask, change: { title: 'Edited' } },
  {
    name: 'notification',
    table: notification,
    values: newNotification,
    change: { readAt: new Date() },
  },
  { name: 'otto_draft', table: ottoDraft, values: newDraft, change: { text: 'Edited' } },
  { name: 'usage_event', table: usageEvent, values: newUsage, change: { quantity: 9 } },
] as const;

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy and the not-empty check on every M5 tenant table', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('task','notification','otto_draft','usage_event')
      order by c.relname`);
    expect(result.rows).toEqual(M5_TABLES.map((table) => ({ table, enabled: true, forced: true })));
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(M5_TABLES));
    const checks = await db.execute<{ table: string }>(sql`
      select c.relname as "table" from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and k.conname like '%organization_id_not_empty'
        and c.relname in ('task','notification','otto_draft','usage_event')
      order by c.relname`);
    expect(checks.rows.map((r) => r.table)).toEqual(M5_TABLES);
  });

  it('user_today_prefs has no organization_id', async () => {
    const result = await db.execute(
      sql`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'user_today_prefs' and column_name = 'organization_id'`,
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe.each(tables)('$name isolation', ({ table, values, change }) => {
  it('org B cannot read org A rows', async () => {
    await withTenant(db, 'org_a', (tx) => tx.insert(table).values(values('org_a') as never));
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(table))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(table))).toHaveLength(1);
    expect(await db.select().from(table)).toHaveLength(0);
  });

  it('org B cannot insert a row stamped with org A', async () => {
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(table).values(values('org_a') as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('org B cannot update org A rows', async () => {
    await withTenant(db, 'org_a', (tx) => tx.insert(table).values(values('org_a') as never));
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx
        .update(table)
        .set(change as never)
        .returning(),
    );
    // Either filtered by RLS (0 rows) or refused by grants; never changes a row.
    const outcome = await attempt.then((rows) => rows.length, pgMessage);
    expect(outcome === 0 || /permission denied/.test(String(outcome))).toBe(true);
    const [stored] = await admin.db.select().from(table);
    expect(JSON.stringify(stored)).not.toContain('Edited');
    expect(JSON.stringify(stored)).not.toContain('"quantity":9');
  });
});

describe('task', () => {
  it('defaults status to open', async () => {
    const [row] = await withTenant(db, 'org_a', (tx) =>
      tx.insert(task).values(newTask('org_a')).returning(),
    );
    expect(row).toMatchObject({ status: 'open', completedAt: null, contactId: null });
    expect(row?.id).toMatch(/^tk_/);
  });

  it('rejects status done without completed_at, and completed_at while open', async () => {
    const done = withTenant(db, 'org_a', (tx) =>
      tx.insert(task).values(newTask('org_a', { status: 'done' }) as never),
    );
    await expect(done.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const open = withTenant(db, 'org_a', (tx) =>
      tx.insert(task).values(newTask('org_a', { completedAt: new Date() }) as never),
    );
    await expect(open.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const ok = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(task)
        .values(newTask('org_a', { status: 'done', completedAt: new Date() }) as never)
        .returning(),
    );
    expect(ok).toHaveLength(1);
  });

  it('rejects an invalid status', async () => {
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(task).values(newTask('org_a', { status: 'later' }) as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });

  it('rejects a contact from another org (composite FK) and accepts an own one', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(task).values(newTask('org_b', { contactId: ana.id }) as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
    const ok = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(task)
        .values(newTask('org_a', { contactId: ana.id }) as never)
        .returning(),
    );
    expect(ok).toHaveLength(1);
  });

  it('is mutable and deletable by its own org', async () => {
    const [row] = await withTenant(db, 'org_a', (tx) =>
      tx.insert(task).values(newTask('org_a')).returning(),
    );
    const id = row?.id ?? '';
    const updated = await withTenant(db, 'org_a', (tx) =>
      tx.update(task).set({ title: 'Edited' }).where(eq(task.id, id)).returning(),
    );
    expect(updated).toHaveLength(1);
    const deleted = await withTenant(db, 'org_a', (tx) =>
      tx.delete(task).where(eq(task.id, id)).returning(),
    );
    expect(deleted).toHaveLength(1);
  });
});

describe('notification', () => {
  it('may update read_at but nothing else, and cannot be deleted', async () => {
    const [row] = await withTenant(db, 'org_a', (tx) =>
      tx.insert(notification).values(newNotification('org_a')).returning(),
    );
    const id = row?.id ?? '';
    const title = withTenant(db, 'org_a', (tx) =>
      tx.update(notification).set({ title: 'Edited' }).where(eq(notification.id, id)),
    );
    await expect(title.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const read = await withTenant(db, 'org_a', (tx) =>
      tx
        .update(notification)
        .set({ readAt: new Date() })
        .where(eq(notification.id, id))
        .returning(),
    );
    expect(read[0]?.readAt).toBeInstanceOf(Date);
    const del = withTenant(db, 'org_a', (tx) =>
      tx.delete(notification).where(eq(notification.id, id)),
    );
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });

  it('rejects a duplicate (org, user, dedupe_key) and an invalid kind', async () => {
    await withTenant(db, 'org_a', (tx) => tx.insert(notification).values(newNotification('org_a')));
    const dup = withTenant(db, 'org_a', (tx) =>
      tx.insert(notification).values(newNotification('org_a')),
    );
    await expect(dup.catch(pgMessage)).resolves.toMatch(/unique/);
    const bad = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(notification)
        .values(newNotification('org_a', { kind: 'gossip', dedupeKey: 'k2' }) as never),
    );
    await expect(bad.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('otto_draft and usage_event are append-only', () => {
  it.each([
    ['otto_draft', ottoDraft, newDraft, { text: 'Edited' }],
    ['usage_event', usageEvent, newUsage, { quantity: 9 }],
  ] as const)(
    '%s cannot be updated or deleted by the app role',
    async (_, table, values, change) => {
      const [row] = await withTenant(db, 'org_a', (tx) =>
        tx
          .insert(table)
          .values(values('org_a') as never)
          .returning(),
      );
      const id = (row as { id: string }).id;
      const upd = withTenant(db, 'org_a', (tx) =>
        tx
          .update(table)
          .set(change as never)
          .where(eq(table.id, id)),
      );
      await expect(upd.catch(pgMessage)).resolves.toMatch(/permission denied/);
      const del = withTenant(db, 'org_a', (tx) => tx.delete(table).where(eq(table.id, id)));
      await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
    },
  );

  it('otto_draft rejects invalid kind and channel, and defaults citations to []', async () => {
    const badKind = withTenant(db, 'org_a', (tx) =>
      tx.insert(ottoDraft).values(newDraft('org_a', { kind: 'poem' }) as never),
    );
    await expect(badKind.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const badChannel = withTenant(db, 'org_a', (tx) =>
      tx.insert(ottoDraft).values(newDraft('org_a', { channel: 'fax' }) as never),
    );
    await expect(badChannel.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const [row] = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(ottoDraft)
        .values(newDraft('org_a', { channel: 'sms' }) as never)
        .returning(),
    );
    expect(row?.citations).toEqual([]);
  });

  it('usage_event enforces idempotency, service and quantity checks, and returns micros as number', async () => {
    const [row] = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(usageEvent)
        .values(newUsage('org_a', { costMicros: 1234567 }) as never)
        .returning(),
    );
    expect(row?.costMicros).toBe(1234567);
    expect(row?.userId).toBeNull();
    const dup = withTenant(db, 'org_a', (tx) =>
      tx.insert(usageEvent).values(newUsage('org_a') as never),
    );
    await expect(dup.catch(pgMessage)).resolves.toMatch(/unique/);
    const badService = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(usageEvent)
        .values(newUsage('org_a', { service: 'fax', idempotencyKey: 'u2' }) as never),
    );
    await expect(badService.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const negative = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(usageEvent)
        .values(newUsage('org_a', { quantity: -1, idempotencyKey: 'u3' }) as never),
    );
    await expect(negative.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });

  it('usage_event survives deletion of its organization (no FK)', async () => {
    await admin.db
      .insert(organization)
      .values({ id: 'org_tmp', name: 'Tmp', slug: 'org-tmp', createdAt: new Date() });
    await withTenant(db, 'org_tmp', (tx) =>
      tx.insert(usageEvent).values(newUsage('org_tmp') as never),
    );
    await admin.db.delete(organization).where(eq(organization.id, 'org_tmp'));
    const rows = await admin.db
      .select()
      .from(usageEvent)
      .where(eq(usageEvent.organizationId, 'org_tmp'));
    expect(rows).toHaveLength(1);
  });
});

describe('user_today_prefs', () => {
  it('is reachable without a tenant context and applies defaults', async () => {
    await db.insert(userTodayPrefs).values({ userId: USER_ID });
    const rows = await db.select().from(userTodayPrefs).where(eq(userTodayPrefs.userId, USER_ID));
    expect(rows).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        dailyGoal: 6,
        widgetOrder: [],
        hiddenWidgets: [],
      }),
    ]);
  });

  it.each([0, 13])('rejects daily_goal = %i', async (dailyGoal) => {
    const attempt = db.insert(userTodayPrefs).values({ userId: USER_ID, dailyGoal });
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

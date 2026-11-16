import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditEvent,
  type Contact,
  contact,
  contactDuplicateDismissal,
  contactPermissionEvent,
  createDb,
  organization,
  type Tx,
  timelineEvent,
  user,
  userPrefs,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

// Admin: migrations, seeding, cleanup. App (knoqra_app, NOBYPASSRLS): every assertion.
const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

const NEW_TENANT_TABLES = [
  'contact_duplicate_dismissal',
  'contact_permission_event',
  'timeline_event',
];

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
    .values({ id: 'user_prefs_1', name: 'Pat', email: 'pat-m1@example.test' })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await admin.db.execute(
    sql`truncate table contact, audit_event, contact_permission_event, timeline_event, contact_duplicate_dismissal, user_prefs, task, notification, otto_draft, usage_event, user_today_prefs cascade`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

const permission = (orgId: string, contactId: string) => ({
  organizationId: orgId,
  contactId,
  channel: 'sms' as const,
  status: 'granted' as const,
  source: 'manual' as const,
});
const timeline = (orgId: string, contactId: string) => ({
  organizationId: orgId,
  contactId,
  kind: 'note' as const,
  title: 'Note',
});

async function onlyRow<T>(rows: Promise<T[]>): Promise<T> {
  const [row] = await rows;
  if (!row) throw new Error('expected one row');
  return row;
}

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy on every new tenant table', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in
        ('contact_permission_event', 'timeline_event', 'contact_duplicate_dismissal')
      order by c.relname`);
    expect(result.rows).toEqual(
      NEW_TENANT_TABLES.map((table) => ({ table, enabled: true, forced: true })),
    );
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(
      expect.arrayContaining(NEW_TENANT_TABLES),
    );
  });

  it('every new tenant table has the organization_id not-empty check', async () => {
    const result = await db.execute<{ table: string }>(sql`
      select c.relname as "table" from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and k.conname like '%organization_id_not_empty'
        and c.relname in ('contact_permission_event', 'timeline_event', 'contact_duplicate_dismissal')
      order by c.relname`);
    expect(result.rows.map((r) => r.table)).toEqual(NEW_TENANT_TABLES);
  });

  it('user_prefs has no organization_id (user-scoped, not tenant-scoped)', async () => {
    const result = await db.execute(
      sql`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'user_prefs' and column_name = 'organization_id'`,
    );
    expect(result.rows).toHaveLength(0);
  });
});

describe('contact_permission_event isolation', () => {
  it('org B cannot read org A rows', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(contactPermissionEvent).values(permission('org_a', ana.id)),
    );
    const seenByB = await withTenant(db, 'org_b', (tx) => tx.select().from(contactPermissionEvent));
    const seenByA = await withTenant(db, 'org_a', (tx) => tx.select().from(contactPermissionEvent));
    expect(seenByB).toHaveLength(0);
    expect(seenByA).toHaveLength(1);
    expect(await db.select().from(contactPermissionEvent)).toHaveLength(0);
  });

  it('org B cannot insert a row stamped with org A', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(contactPermissionEvent).values(permission('org_a', ana.id)),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it.each([
    ['channel', { channel: 'fax' }],
    ['status', { status: 'maybe' }],
    ['source', { source: 'telepathy' }],
  ])('rejects an invalid %s', async (_, override) => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(contactPermissionEvent)
        .values({ ...permission('org_a', ana.id), ...override } as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('timeline_event isolation', () => {
  it('org B cannot read org A rows', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(timelineEvent).values(timeline('org_a', ana.id)),
    );
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(timelineEvent))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(timelineEvent))).toHaveLength(1);
    expect(await db.select().from(timelineEvent)).toHaveLength(0);
  });

  it('org B cannot insert a row stamped with org A', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(timelineEvent).values(timeline('org_a', ana.id)),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('rejects an invalid kind', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(timelineEvent).values({ ...timeline('org_a', ana.id), kind: 'gossip' } as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('contact_duplicate_dismissal isolation', () => {
  async function twoContacts(orgId: string) {
    const first = await addContact(orgId, 'One', '+12025550111');
    const second = await addContact(orgId, 'Two', '+12025550112');
    const [a, b] = [first.id, second.id].sort();
    if (!a || !b) throw new Error('no ids');
    return { a, b };
  }
  const dismissal = (orgId: string, a: string, b: string) => ({
    organizationId: orgId,
    contactAId: a,
    contactBId: b,
  });

  it('org B cannot read org A rows', async () => {
    const { a, b } = await twoContacts('org_a');
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, b)),
    );
    const seenByB = await withTenant(db, 'org_b', (tx) =>
      tx.select().from(contactDuplicateDismissal),
    );
    const seenByA = await withTenant(db, 'org_a', (tx) =>
      tx.select().from(contactDuplicateDismissal),
    );
    expect(seenByB).toHaveLength(0);
    expect(seenByA).toHaveLength(1);
  });

  it('org B cannot insert a row stamped with org A', async () => {
    const { a, b } = await twoContacts('org_a');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, b)),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('org B cannot update or delete org A rows', async () => {
    const { a, b } = await twoContacts('org_a');
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, b)),
    );
    const where = and(
      eq(contactDuplicateDismissal.contactAId, a),
      eq(contactDuplicateDismissal.contactBId, b),
    );
    const updated = await withTenant(db, 'org_b', (tx) =>
      tx
        .update(contactDuplicateDismissal)
        .set({ dismissedBy: 'intruder' })
        .where(where)
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(db, 'org_b', (tx) =>
      tx.delete(contactDuplicateDismissal).where(where).returning(),
    );
    expect(deleted).toHaveLength(0);
    const stored = await onlyRow(admin.db.select().from(contactDuplicateDismissal));
    expect(stored.dismissedBy).toBeNull();
  });

  it('rejects a >= b (equal and reversed) and a duplicate pair', async () => {
    const { a, b } = await twoContacts('org_a');
    const reversed = withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', b, a)),
    );
    await expect(reversed.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const equal = withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, a)),
    );
    await expect(equal.catch(pgMessage)).resolves.toMatch(/check constraint/);
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, b)),
    );
    const duplicate = withTenant(db, 'org_a', (tx) =>
      tx.insert(contactDuplicateDismissal).values(dismissal('org_a', a, b)),
    );
    await expect(duplicate.catch(pgMessage)).resolves.toMatch(/unique/);
  });
});

describe('cross-tenant foreign keys', () => {
  it('org B cannot SEE an org A contact, so a visibility lookup before insert finds nothing', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const visible = await withTenant(db, 'org_b', (tx) =>
      tx.select().from(contact).where(eq(contact.id, ana.id)),
    );
    expect(visible).toHaveLength(0);
  });
  // FK checks bypass RLS, so the foreign key itself is tenant-scoped: (organization_id, contact_id)
  // references contact (organization_id, id). Org B cannot point at an org A contact.
  it.each([
    ['timeline_event', () => timelineEvent],
    ['contact_permission_event', () => contactPermissionEvent],
  ])(
    '%s: org B row referencing an org A contact id is rejected by the foreign key',
    async (_, table) => {
      const ana = await addContact('org_a', 'Ana', '+12025550101');
      const values =
        table() === timelineEvent ? timeline('org_b', ana.id) : permission('org_b', ana.id);
      const attempt = withTenant(db, 'org_b', (tx) => tx.insert(table()).values(values as never));
      await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
    },
  );

  it('a dismissal for org B referencing org A contacts is rejected by the foreign key', async () => {
    const one = await addContact('org_a', 'One', '+12025550111');
    const two = await addContact('org_a', 'Two', '+12025550112');
    const [a, b] = [one.id, two.id].sort();
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx
        .insert(contactDuplicateDismissal)
        .values({ organizationId: 'org_b', contactAId: a as string, contactBId: b as string }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
  });

  it('org B cannot set merged_into_id to an org A contact', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const ben = await addContact('org_b', 'Ben', '+12025550102');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.update(contact).set({ mergedIntoId: ana.id }).where(eq(contact.id, ben.id)),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
  });

  it("deleting org A's contact leaves org B rows untouched (and cascades only org A's)", async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const ben = await addContact('org_b', 'Ben', '+12025550101');
    await withTenant(db, 'org_a', async (tx) => {
      await tx.insert(timelineEvent).values(timeline('org_a', ana.id));
      await tx.insert(contactPermissionEvent).values(permission('org_a', ana.id));
    });
    await withTenant(db, 'org_b', async (tx) => {
      await tx.insert(timelineEvent).values(timeline('org_b', ben.id));
      await tx.insert(contactPermissionEvent).values(permission('org_b', ben.id));
    });
    await withTenant(db, 'org_a', (tx) => tx.delete(contact).where(eq(contact.id, ana.id)));
    const timelineRows = await admin.db.select().from(timelineEvent);
    const permissionRows = await admin.db.select().from(contactPermissionEvent);
    expect(timelineRows.map((r) => r.organizationId)).toEqual(['org_b']);
    expect(permissionRows.map((r) => r.organizationId)).toEqual(['org_b']);
  });

  it('a nonexistent contact id is rejected by the foreign key', async () => {
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(timelineEvent).values(timeline('org_a', 'ct_doesnotexist')),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
  });
});

describe('user_prefs', () => {
  it('is reachable without a tenant context', async () => {
    await db.insert(userPrefs).values({ userId: 'user_prefs_1', timezone: 'Europe/Berlin' });
    const rows = await db.select().from(userPrefs).where(eq(userPrefs.userId, 'user_prefs_1'));
    expect(rows).toEqual([
      expect.objectContaining({
        userId: 'user_prefs_1',
        timezone: 'Europe/Berlin',
        theme: 'system',
        notifyEmail: true,
        notifyDesktop: true,
      }),
    ]);
  });

  it('rejects an invalid theme', async () => {
    const attempt = db.insert(userPrefs).values({ userId: 'user_prefs_1', theme: 'neon' } as never);
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('contact M1 columns', () => {
  it('defaults tags to empty and the optional columns to null', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    expect(ana).toMatchObject({
      email: null,
      jobTitle: null,
      tags: [],
      sourceDetail: null,
      archivedAt: null,
      mergedIntoId: null,
    });
  });

  it('merged_into_id is nulled when the target contact is deleted', async () => {
    const winner = await addContact('org_a', 'Winner', '+12025550101');
    const loser = await addContact('org_a', 'Loser', '+12025550102');
    await withTenant(db, 'org_a', (tx) =>
      tx.update(contact).set({ mergedIntoId: winner.id }).where(eq(contact.id, loser.id)),
    );
    await withTenant(db, 'org_a', (tx) => tx.delete(contact).where(eq(contact.id, winner.id)));
    const stored = await onlyRow(admin.db.select().from(contact).where(eq(contact.id, loser.id)));
    expect(stored.mergedIntoId).toBeNull();
  });

  it('keeps phone numbers unique among unmerged contacts only', async () => {
    const target = await addContact('org_a', 'Target', '+12025550101');
    const source = await addContact('org_a', 'Source', '+12025550102');
    const taken = addContact('org_a', 'Taken', '+12025550102');
    await expect(taken.catch(pgMessage)).resolves.toMatch(/unique/);
    await withTenant(db, 'org_a', (tx) =>
      tx
        .update(contact)
        .set({ mergedIntoId: target.id, archivedAt: new Date() })
        .where(eq(contact.id, source.id)),
    );
    // The merged source releases its number; an archived (unmerged) holder would not.
    const reused = await addContact('org_a', 'Reused', '+12025550102');
    expect(reused.phoneE164).toBe(source.phoneE164);
    const again = addContact('org_a', 'Again', '+12025550102');
    await expect(again.catch(pgMessage)).resolves.toMatch(/unique/);
  });

  it('the phone index is the partial unique index on unmerged rows', async () => {
    const result = await db.execute<{ def: string }>(sql`
      select indexdef as def from pg_indexes
      where tablename = 'contact' and indexname = 'contact_organization_id_phone_e164_unique'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.def).toMatch(/^CREATE UNIQUE INDEX/);
    expect(result.rows[0]?.def).toMatch(/WHERE \(merged_into_id IS NULL\)/);
  });

  it('sorts by name through the stored sort_name key (migration 0012, ruling R1)', async () => {
    const generated = await db.execute<{ name: string; expr: string }>(sql`
      select a.attname as name, pg_get_expr(d.adbin, d.adrelid) as expr
      from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'contact'::regclass and a.attgenerated = 's'
        and a.attname in ('sort_name', 'name_key', 'email_key', 'search_text')
      order by a.attname`);
    // The same \s+ regex and the U+001F separator the queries rely on (ruling R1).
    const sep = String.fromCharCode(0x1f);
    expect(Object.fromEntries(generated.rows.map((r) => [r.name, r.expr]))).toEqual({
      email_key: 'lower(email)',
      name_key: "lower(btrim(regexp_replace(display_name, '\\s+'::text, ' '::text, 'g'::text)))",
      search_text: `((((lower(display_name) || '${sep}'::text) || lower(COALESCE(company, ''::text))) || '${sep}'::text) || lower(COALESCE(email, ''::text)))`,
      sort_name: 'lower(display_name)',
    });
    const result = await db.execute<{ name: string; def: string }>(sql`
      select indexname as name, indexdef as def from pg_indexes
      where tablename = 'contact' and indexname like 'contact_%active_%_idx' order by indexname`);
    const active = 'WHERE ((archived_at IS NULL) AND (merged_into_id IS NULL)';
    expect(result.rows).toEqual([
      {
        name: 'contact_active_email_key_idx',
        def: expect.stringContaining(
          `(organization_id, email_key) ${active} AND (email_key IS NOT NULL))`,
        ),
      },
      {
        name: 'contact_active_name_key_idx',
        def: expect.stringContaining(`(organization_id, name_key) ${active})`),
      },
      {
        name: 'contact_active_sort_idx',
        def: expect.stringContaining(`(organization_id, sort_name, id) ${active})`),
      },
      {
        name: 'contact_inactive_sort_idx',
        def: expect.stringContaining(
          '(organization_id, sort_name, id) WHERE ((archived_at IS NOT NULL) OR (merged_into_id IS NOT NULL))',
        ),
      },
    ]);
    // The expression index it replaces is gone.
    const old = await db.execute(sql`
      select 1 from pg_indexes where tablename = 'contact' and indexdef ilike '%lower(display_name)%'`);
    expect(old.rows).toHaveLength(0);
  });
});

describe('append-only history (permission and timeline events)', () => {
  const tables = [
    {
      name: 'contact_permission_event',
      table: contactPermissionEvent,
      insert: async (tx: Tx, orgId: string, contactId: string) => {
        const [row] = await tx
          .insert(contactPermissionEvent)
          .values(permission(orgId, contactId))
          .returning({ id: contactPermissionEvent.id });
        return row?.id ?? '';
      },
      change: { status: 'revoked' },
    },
    {
      name: 'timeline_event',
      table: timelineEvent,
      insert: async (tx: Tx, orgId: string, contactId: string) => {
        const [row] = await tx
          .insert(timelineEvent)
          .values(timeline(orgId, contactId))
          .returning({ id: timelineEvent.id });
        return row?.id ?? '';
      },
      change: { title: 'Edited' },
    },
  ] as const;

  describe.each(tables)('$name', ({ table, insert, change }) => {
    async function seed(orgId = 'org_a') {
      const owner = await addContact(orgId, 'Ana', '+12025550101');
      const id = await withTenant(db, orgId, (tx) => insert(tx, orgId, owner.id));
      const row = { id };
      return { owner, row };
    }

    it.each(['org_a', 'org_b'])(
      '%s cannot UPDATE a column other than contact_id',
      async (actor) => {
        const { row } = await seed();
        const attempt = withTenant(db, actor, (tx) =>
          tx
            .update(table)
            .set(change as never)
            .where(eq(table.id, row.id)),
        );
        await expect(attempt.catch(pgMessage)).resolves.toMatch(/permission denied/);
      },
    );

    it('cannot UPDATE organization_id (even to move a row between its own tenants)', async () => {
      const { row } = await seed();
      const attempt = withTenant(db, 'org_a', (tx) =>
        tx.update(table).set({ organizationId: 'org_b' }).where(eq(table.id, row.id)),
      );
      await expect(attempt.catch(pgMessage)).resolves.toMatch(/permission denied/);
    });

    it.each(['org_a', 'org_b'])('%s cannot DELETE a row', async (actor) => {
      const { row } = await seed();
      const attempt = withTenant(db, actor, (tx) => tx.delete(table).where(eq(table.id, row.id)));
      await expect(attempt.catch(pgMessage)).resolves.toMatch(/permission denied/);
      expect(await admin.db.select().from(table)).toHaveLength(1);
    });

    it("org B setting contact_id on org A's row updates 0 rows", async () => {
      const { row } = await seed();
      const ben = await addContact('org_b', 'Ben', '+12025550102');
      const updated = await withTenant(db, 'org_b', (tx) =>
        tx.update(table).set({ contactId: ben.id }).where(eq(table.id, row.id)).returning(),
      );
      expect(updated).toHaveLength(0);
    });

    it('org A can re-point contact_id to another contact of its own org (merge)', async () => {
      const { row } = await seed();
      const winner = await addContact('org_a', 'Winner', '+12025550103');
      const updated = await withTenant(db, 'org_a', (tx) =>
        tx.update(table).set({ contactId: winner.id }).where(eq(table.id, row.id)).returning(),
      );
      expect(updated).toHaveLength(1);
      const [stored] = await admin.db.select().from(table);
      expect(stored?.contactId).toBe(winner.id);
    });

    it('org A cannot re-point contact_id to an org B contact', async () => {
      const { row } = await seed();
      const ben = await addContact('org_b', 'Ben', '+12025550102');
      const attempt = withTenant(db, 'org_a', (tx) =>
        tx.update(table).set({ contactId: ben.id }).where(eq(table.id, row.id)),
      );
      await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
    });

    it('deleting the contact still cascades to its history rows', async () => {
      const { owner } = await seed();
      await withTenant(db, 'org_a', (tx) => tx.delete(contact).where(eq(contact.id, owner.id)));
      expect(await admin.db.select().from(table)).toHaveLength(0);
    });
  });

  it('audit_event is append-only for the app role too', async () => {
    const [row] = await admin.db
      .insert(auditEvent)
      .values({ organizationId: 'org_a', action: 'seed', entityType: 'test', outcome: 'allowed' })
      .returning();
    if (!row) throw new Error('no row');
    const update = withTenant(db, 'org_a', (tx) =>
      tx.update(auditEvent).set({ action: 'edited' }).where(eq(auditEvent.id, row.id)),
    );
    await expect(update.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) =>
      tx.delete(auditEvent).where(eq(auditEvent.id, row.id)),
    );
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const inserted = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(auditEvent)
        .values({ organizationId: 'org_a', action: 'ok', entityType: 'test', outcome: 'allowed' })
        .returning(),
    );
    expect(inserted).toHaveLength(1);
  });
});

describe('merge-style re-pointing within one org', () => {
  it('sets merged_into_id to a same-org contact', async () => {
    const winner = await addContact('org_a', 'Winner', '+12025550101');
    const loser = await addContact('org_a', 'Loser', '+12025550102');
    const [updated] = await withTenant(db, 'org_a', (tx) =>
      tx
        .update(contact)
        .set({ mergedIntoId: winner.id })
        .where(eq(contact.id, loser.id))
        .returning(),
    );
    expect(updated?.mergedIntoId).toBe(winner.id);
  });

  it('SET NULL on the self FK nulls only merged_into_id, not organization_id', async () => {
    const winner = await addContact('org_a', 'Winner', '+12025550101');
    const loser = await addContact('org_a', 'Loser', '+12025550102');
    await withTenant(db, 'org_a', (tx) =>
      tx.update(contact).set({ mergedIntoId: winner.id }).where(eq(contact.id, loser.id)),
    );
    await withTenant(db, 'org_a', (tx) => tx.delete(contact).where(eq(contact.id, winner.id)));
    const stored = await onlyRow(admin.db.select().from(contact).where(eq(contact.id, loser.id)));
    expect(stored).toMatchObject({ organizationId: 'org_a', mergedIntoId: null });
  });
});

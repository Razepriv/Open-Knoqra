import { createServer, type Server, type Socket } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditEvent,
  type Contact,
  contact,
  createDb,
  type Database,
  organization,
  type Tx,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

// Admin (owner/superuser) connection: migrations, seeding and cleanup only.
const admin = createDb(migrationUrl);
// App-role connection (knoqra_app, NOBYPASSRLS): every assertion runs through this one.
// Default pool size 1: one physical connection, so the "same connection" tests mean what they say.
const app = createDb(appUrl);
const db = app.db;

/** Inserts a contact as tenant `orgId` through the app role and returns it. */
async function addContact(orgId: string, displayName: string, phoneE164: string): Promise<Contact> {
  const [row] = await withTenant(db, orgId, (tx) =>
    tx.insert(contact).values({ organizationId: orgId, displayName, phoneE164 }).returning(),
  );
  if (!row) throw new Error('insert returned no row');
  return row;
}

async function currentOrg(conn: Database | Tx): Promise<string | null> {
  const result = await conn.execute<{ org: string | null }>(
    sql`select current_setting('app.org_id', true) as org`,
  );
  return result.rows[0]?.org ?? null;
}

async function backendPid(): Promise<number> {
  const result = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error('no backend pid');
  return pid;
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
});

beforeEach(async () => {
  await admin.db.execute(
    sql`truncate table contact, audit_event, contact_permission_event, timeline_event, contact_duplicate_dismissal, task, notification, otto_draft, usage_event cascade`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

describe('tenant isolation (row-level security)', () => {
  it('runs assertions as a role that cannot bypass RLS', async () => {
    const result = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(result.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it('a tenant only sees its own contacts', async () => {
    await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(contact)
        .values({ organizationId: 'org_a', displayName: 'Ana', phoneE164: '+12025550101' }),
    );
    await withTenant(db, 'org_b', (tx) =>
      tx
        .insert(contact)
        .values({ organizationId: 'org_b', displayName: 'Ben', phoneE164: '+12025550102' }),
    );
    const seenByA = await withTenant(db, 'org_a', (tx) => tx.select().from(contact));
    expect(seenByA.map((c) => c.displayName)).toEqual(['Ana']);
  });

  it('no tenant context sees nothing', async () => {
    expect(await db.select().from(contact)).toHaveLength(0);
  });

  it('no tenant context sees nothing even though rows exist', async () => {
    await admin.db.insert(contact).values([
      { organizationId: 'org_a', displayName: 'Ana', phoneE164: '+12025550101' },
      { organizationId: 'org_b', displayName: 'Ben', phoneE164: '+12025550102' },
    ]);
    expect(await admin.db.select().from(contact)).toHaveLength(2);
    expect(await db.select().from(contact)).toHaveLength(0);
  });

  it('cannot insert a row for another tenant', async () => {
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(contact)
        .values({ organizationId: 'org_b', displayName: 'X', phoneE164: '+12025550103' }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
    expect(await admin.db.select().from(contact)).toHaveLength(0);
  });

  it('tenant setting does not leak to the next transaction on the same connection', async () => {
    await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(contact)
        .values({ organizationId: 'org_a', displayName: 'Ana', phoneE164: '+12025550101' }),
    );
    await withTenant(db, 'org_a', async () => {});
    expect(await db.select().from(contact)).toHaveLength(0);
  });

  it.each(['', '   ', ' org_a', 'org_a ', '\torg_a', 'org_a\n'])(
    'rejects the organization id %j before running the callback',
    async (orgId) => {
      let ran = false;
      const attempt = withTenant(db, orgId, async () => {
        ran = true;
      });
      await expect(attempt).rejects.toThrow(/organization id/);
      expect(ran).toBe(false);
    },
  );

  it('passes the exact organization id to set_config', async () => {
    expect(await withTenant(db, 'org_a', (tx) => currentOrg(tx))).toBe('org_a');
  });

  it('concurrent withTenant calls on one handle each see only their own tenant', async () => {
    await addContact('org_a', 'Ana', '+12025550101');
    await addContact('org_b', 'Ben', '+12025550102');
    const readAs = (orgId: string) =>
      withTenant(db, orgId, async (tx) => {
        const before = await currentOrg(tx);
        const rows = await tx.select().from(contact);
        const after = await currentOrg(tx);
        return { before, after, orgs: rows.map((r) => r.organizationId) };
      });
    const results = await Promise.all([
      readAs('org_a'),
      readAs('org_b'),
      readAs('org_a'),
      readAs('org_b'),
    ]);
    expect(results).toEqual([
      { before: 'org_a', after: 'org_a', orgs: ['org_a'] },
      { before: 'org_b', after: 'org_b', orgs: ['org_b'] },
      { before: 'org_a', after: 'org_a', orgs: ['org_a'] },
      { before: 'org_b', after: 'org_b', orgs: ['org_b'] },
    ]);
  });
});

describe('empty tenant context fails closed', () => {
  it("after a tenant transaction, organization_id = '' is neither writable nor readable", async () => {
    const pid = await backendPid();
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(auditEvent).values({
        organizationId: 'org_a',
        action: 'seed',
        entityType: 'test',
        outcome: 'allowed',
      }),
    );
    // Plain (non-tenant) transactions pin one connection, so each block below provably runs on
    // the session where app.org_id has reverted to '' (not NULL) after the tenant transaction.
    const session = async (tx: Tx) => {
      const result = await tx.execute<{ pid: number; org: string | null }>(
        sql`select pg_backend_pid() as pid, current_setting('app.org_id', true) as org`,
      );
      return result.rows[0];
    };
    const insert = db.transaction(async (tx) => {
      expect(await session(tx)).toEqual({ pid, org: '' });
      await tx
        .insert(auditEvent)
        .values({ organizationId: '', action: 'probe', entityType: 'test', outcome: 'allowed' });
    });
    await expect(insert.catch(pgMessage)).resolves.toMatch(/row-level security|check constraint/);

    const read = await db.transaction(async (tx) => ({
      session: await session(tx),
      auditEvents: await tx.select().from(auditEvent),
      contacts: await tx.select().from(contact),
    }));
    expect(read).toEqual({ session: { pid, org: '' }, auditEvents: [], contacts: [] });
    const stored = await admin.db.select().from(auditEvent);
    expect(stored.map((e) => e.organizationId)).toEqual(['org_a']);
  });

  it.each([
    [
      'contact',
      sql`insert into contact (id, organization_id, display_name, phone_e164)
          values ('ct_empty', '', 'X', '+12025550109')`,
    ],
    [
      'audit_event',
      sql`insert into audit_event (id, organization_id, action, entity_type, outcome)
          values ('ae_empty', '', 'probe', 'test', 'allowed')`,
    ],
  ])('%s rejects an empty organization_id even for the owner', async (_, statement) => {
    await expect(admin.db.execute(statement).catch(pgMessage)).resolves.toMatch(/check constraint/);
  });
});

describe('contact write isolation', () => {
  it("cannot update another tenant's contact", async () => {
    const ben = await addContact('org_b', 'Ben', '+12025550102');
    const updated = await withTenant(db, 'org_a', (tx) =>
      tx.update(contact).set({ displayName: 'Hijacked' }).where(eq(contact.id, ben.id)).returning(),
    );
    expect(updated).toHaveLength(0);
    const [stored] = await admin.db.select().from(contact).where(eq(contact.id, ben.id));
    expect(stored?.displayName).toBe('Ben');
  });

  it("cannot delete another tenant's contact", async () => {
    const ben = await addContact('org_b', 'Ben', '+12025550102');
    const deleted = await withTenant(db, 'org_a', (tx) =>
      tx.delete(contact).where(eq(contact.id, ben.id)).returning(),
    );
    expect(deleted).toHaveLength(0);
    expect(await admin.db.select().from(contact).where(eq(contact.id, ben.id))).toHaveLength(1);
  });

  it('cannot move its own contact to another tenant', async () => {
    const ana = await addContact('org_a', 'Ana', '+12025550101');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.update(contact).set({ organizationId: 'org_b' }).where(eq(contact.id, ana.id)),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
    const [stored] = await admin.db.select().from(contact).where(eq(contact.id, ana.id));
    expect(stored?.organizationId).toBe('org_a');
  });
});

describe('audit_event isolation', () => {
  const event = (organizationId: string, action: string) => ({
    organizationId,
    action,
    entityType: 'contact',
    outcome: 'allowed' as const,
  });

  it('a tenant only reads its own audit events', async () => {
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(auditEvent).values(event('org_a', 'a.created')),
    );
    await withTenant(db, 'org_b', (tx) =>
      tx.insert(auditEvent).values(event('org_b', 'b.created')),
    );
    const seenByA = await withTenant(db, 'org_a', (tx) => tx.select().from(auditEvent));
    const seenByB = await withTenant(db, 'org_b', (tx) => tx.select().from(auditEvent));
    expect(seenByA.map((e) => e.action)).toEqual(['a.created']);
    expect(seenByB.map((e) => e.action)).toEqual(['b.created']);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
  });

  it('cannot insert an audit event for another tenant', async () => {
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(auditEvent).values(event('org_b', 'forged')),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
    expect(await admin.db.select().from(auditEvent)).toHaveLength(0);
  });
});

describe('schema catalog', () => {
  // Better Auth tables: Better Auth reads them outside any tenant context; isolation is in app code.
  // call_route and provider_number_route are system tables resolved before any tenant is known.
  // System tables read before any tenant is known. provider_event_raw.organization_id only marks
  // which workspace's key verified a delivery.
  const RLS_EXEMPT = [
    'invitation',
    'member',
    'call_route',
    'provider_number_route',
    'provider_event_raw',
  ];

  it('every public table with organization_id forces RLS, except the allowlist', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and a.attname = 'organization_id' and not a.attisdropped
      order by c.relname`);
    const tables = result.rows.map((r) => r.table);
    expect(tables).toEqual(expect.arrayContaining(['audit_event', 'contact', ...RLS_EXEMPT]));
    const unprotected = result.rows.filter(
      (r) => !RLS_EXEMPT.includes(r.table) && !(r.enabled && r.forced),
    );
    expect(unprotected).toEqual([]);
  });
});

describe('createDb', () => {
  const wrongPassword = (() => {
    const url = new URL(appUrl);
    url.password = 'wrong-password';
    return url.toString();
  })();

  it.each([
    ['a wrong password', wrongPassword, /password authentication failed/],
    ['a refused port', 'postgres://nobody:nobody@127.0.0.1:1/none', /ECONNREFUSED/],
  ])('rejects queries with the real connection error for %s', async (_, url, expected) => {
    const broken = createDb(url);
    const failure = broken.db.execute(sql`select 1`).catch(pgMessage);
    await expect(failure).resolves.toMatch(expected);
    await broken.close();
  });

  it('gives up connecting after connectionTimeoutMillis when the server never answers', async () => {
    // Accepts TCP connections but never speaks the Postgres protocol.
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const address = silent.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const hung = createDb(`postgres://x:x@127.0.0.1:${address.port}/x`, {
      connectionTimeoutMillis: 200,
    });
    const started = Date.now();
    try {
      const failure = hung.db.execute(sql`select 1`).catch(pgMessage);
      await expect(failure).resolves.toMatch(/timeout/i);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await hung.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

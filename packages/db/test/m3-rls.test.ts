import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Contact,
  channelConnection,
  channelRoute,
  contact,
  contactPermissionEvent,
  conversation,
  createDb,
  message,
  messageStatusEvent,
  messageTemplate,
  organization,
  type Tx,
  withTenant,
} from '../src/index';
import { runMigrations } from '../src/migrate';
import { appUrl, migrationUrl, pgMessage } from './helpers';

// Admin: migrations, seeding, cleanup. App (knoqra_app, NOBYPASSRLS): every assertion.
const admin = createDb(migrationUrl);
const app = createDb(appUrl);
const db = app.db;

const M3_TABLES = [
  'channel_connection',
  'channel_route',
  'conversation',
  'message',
  'message_status_event',
  'message_template',
];

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
    sql`truncate table contact, channel_connection, channel_route, conversation, message, message_status_event, message_template, contact_permission_event cascade`,
  );
});

afterAll(async () => {
  await app.close();
  await admin.close();
});

async function addContact(orgId: string, phoneE164: string): Promise<Contact> {
  const [row] = await withTenant(db, orgId, (tx) =>
    tx.insert(contact).values({ organizationId: orgId, displayName: 'Pat', phoneE164 }).returning(),
  );
  if (!row) throw new Error('insert returned no row');
  return row;
}

type Seeded = {
  contactId: string;
  connectionId: string;
  conversationId: string;
  templateId: string;
  messageId: string;
  eventId: string;
};

/** Seeds one full chain for `orgId` through the app role. */
async function seed(orgId: string, phone = '+12025550101'): Promise<Seeded> {
  const owner = await addContact(orgId, phone);
  const address = `sender-${orgId}`;
  return withTenant(db, orgId, async (tx: Tx) => {
    const [conn] = await tx
      .insert(channelConnection)
      .values({ organizationId: orgId, channel: 'sms', provider: 'fake', address })
      .returning();
    if (!conn) throw new Error('no connection');
    await tx.insert(channelRoute).values({
      organizationId: orgId,
      provider: 'fake',
      channel: 'sms',
      address,
      connectionId: conn.id,
    });
    const [conv] = await tx
      .insert(conversation)
      .values({ organizationId: orgId, contactId: owner.id, channel: 'sms' })
      .returning();
    const [tpl] = await tx
      .insert(messageTemplate)
      .values({ organizationId: orgId, name: 'Hello', channel: 'sms', body: 'Hi' })
      .returning();
    if (!conv || !tpl) throw new Error('no conversation or template');
    const [msg] = await tx
      .insert(message)
      .values({
        organizationId: orgId,
        conversationId: conv.id,
        contactId: owner.id,
        channel: 'sms',
        direction: 'outbound',
        body: 'Hi',
        status: 'queued',
        provider: 'fake',
        occurredAt: new Date(),
      })
      .returning();
    if (!msg) throw new Error('no message');
    const [evt] = await tx
      .insert(messageStatusEvent)
      .values({
        organizationId: orgId,
        messageId: msg.id,
        status: 'queued',
        applied: true,
        occurredAt: new Date(),
      })
      .returning();
    if (!evt) throw new Error('no event');
    return {
      contactId: owner.id,
      connectionId: conn.id,
      conversationId: conv.id,
      templateId: tpl.id,
      messageId: msg.id,
      eventId: evt.id,
    };
  });
}

describe('catalog', () => {
  it('forces RLS with a tenant_isolation policy on every M3 table', async () => {
    const result = await db.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as "table", c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in
        ('channel_connection','channel_route','conversation','message','message_status_event','message_template')
      order by c.relname`);
    expect(result.rows).toEqual(M3_TABLES.map((table) => ({ table, enabled: true, forced: true })));
    const policies = await db.execute<{ tablename: string }>(
      sql`select tablename from pg_policies where policyname = 'tenant_isolation'`,
    );
    expect(policies.rows.map((r) => r.tablename)).toEqual(expect.arrayContaining(M3_TABLES));
  });

  it('every M3 table has the organization_id not-empty check', async () => {
    const result = await db.execute<{ table: string }>(sql`
      select distinct c.relname as "table" from pg_constraint k join pg_class c on c.oid = k.conrelid
      where k.contype = 'c' and k.conname like '%organization_id_not_empty'
        and c.relname in
        ('channel_connection','channel_route','conversation','message','message_status_event','message_template')
      order by c.relname`);
    expect(result.rows.map((r) => r.table)).toEqual(M3_TABLES);
  });

  it('indexes thread notes by organization, conversation and newest first for conversation refs', async () => {
    // M6c (migration 0012) extended the key with (occurred_at, id) so the thread keyset reads
    // its notes branch from the index with a LIMIT.
    const result = await db.execute<{ tablename: string; indexdef: string }>(sql`
      select tablename, indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'timeline_event_conversation_ref_idx'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.tablename).toBe('timeline_event');
    expect(result.rows[0]?.indexdef).toContain(
      '(organization_id, ref_id, occurred_at DESC, id DESC)',
    );
    expect(result.rows[0]?.indexdef).toContain("WHERE (ref_type = 'conversation'::text)");
  });
});

describe('tenant isolation', () => {
  const tables = [
    ['channel_connection', channelConnection],
    ['conversation', conversation],
    ['message', message],
    ['message_status_event', messageStatusEvent],
    ['message_template', messageTemplate],
  ] as const;

  it.each(tables)('%s: org B cannot read org A rows', async (_, table) => {
    await seed('org_a');
    expect(await withTenant(db, 'org_b', (tx) => tx.select().from(table))).toHaveLength(0);
    expect(await withTenant(db, 'org_a', (tx) => tx.select().from(table))).toHaveLength(1);
    expect(await db.select().from(table)).toHaveLength(0);
  });

  it('org B cannot insert rows stamped with org A', async () => {
    const ids = await seed('org_a');
    const attempts = [
      (tx: Tx) =>
        tx
          .insert(channelConnection)
          .values({ organizationId: 'org_a', channel: 'whatsapp', provider: 'fake', address: 'x' }),
      (tx: Tx) =>
        tx
          .insert(messageTemplate)
          .values({ organizationId: 'org_a', name: 'Other', channel: 'sms', body: 'b' }),
      (tx: Tx) =>
        tx.insert(conversation).values({
          organizationId: 'org_a',
          contactId: ids.contactId,
          channel: 'whatsapp',
        }),
      (tx: Tx) =>
        tx.insert(message).values({
          organizationId: 'org_a',
          conversationId: ids.conversationId,
          contactId: ids.contactId,
          channel: 'sms',
          direction: 'inbound',
          body: 'x',
          status: 'received',
          provider: 'fake',
          occurredAt: new Date(),
        }),
      (tx: Tx) =>
        tx.insert(messageStatusEvent).values({
          organizationId: 'org_a',
          messageId: ids.messageId,
          status: 'sent',
          applied: true,
          occurredAt: new Date(),
        }),
    ];
    for (const attempt of attempts) {
      const failure = withTenant(db, 'org_b', async (tx) => attempt(tx)).catch(pgMessage);
      await expect(failure).resolves.toMatch(/row-level security/);
    }
  });

  it('org B cannot update org A rows', async () => {
    const ids = await seed('org_a');
    const updated = await withTenant(db, 'org_b', async (tx) => {
      const a = await tx
        .update(conversation)
        .set({ unreadCount: 9 })
        .where(eq(conversation.id, ids.conversationId))
        .returning();
      const b = await tx
        .update(message)
        .set({ status: 'failed' })
        .where(eq(message.id, ids.messageId))
        .returning();
      const c = await tx
        .update(messageTemplate)
        .set({ body: 'hacked' })
        .where(eq(messageTemplate.id, ids.templateId))
        .returning();
      const d = await tx
        .update(channelConnection)
        .set({ registrationStatus: 'approved' })
        .where(eq(channelConnection.id, ids.connectionId))
        .returning();
      return [a, b, c, d];
    });
    for (const rows of updated) expect(rows).toHaveLength(0);
  });
});

describe('channel_route', () => {
  it('org A rows are readable without tenant context', async () => {
    await seed('org_a');
    const rows = await db.select().from(channelRoute);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe('org_a');
  });

  it('org B cannot insert a route for org A', async () => {
    const ids = await seed('org_a');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(channelRoute).values({
        organizationId: 'org_a',
        provider: 'fake',
        channel: 'whatsapp',
        address: 'intruder',
        connectionId: ids.connectionId,
      }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/row-level security/);
  });

  it('the app role cannot update or delete routes', async () => {
    await seed('org_a');
    const update = withTenant(db, 'org_a', (tx) =>
      tx.update(channelRoute).set({ address: 'moved' }),
    );
    await expect(update.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) => tx.delete(channelRoute));
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });

  it('rejects a duplicate (provider, channel, address) even across orgs', async () => {
    await seed('org_a');
    const other = await withTenant(db, 'org_b', (tx) =>
      tx
        .insert(channelConnection)
        .values({ organizationId: 'org_b', channel: 'sms', provider: 'fake', address: 'z' })
        .returning(),
    );
    const connectionId = other[0]?.id as string;
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx.insert(channelRoute).values({
        organizationId: 'org_b',
        provider: 'fake',
        channel: 'sms',
        address: 'sender-org_a',
        connectionId,
      }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/unique/);
  });
});

describe('append-only', () => {
  it('message_status_event: update and delete are denied', async () => {
    const ids = await seed('org_a');
    const update = withTenant(db, 'org_a', (tx) =>
      tx
        .update(messageStatusEvent)
        .set({ applied: false })
        .where(eq(messageStatusEvent.id, ids.eventId)),
    );
    await expect(update.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const del = withTenant(db, 'org_a', (tx) =>
      tx.delete(messageStatusEvent).where(eq(messageStatusEvent.id, ids.eventId)),
    );
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
  });

  it('message: delete is denied, update is allowed', async () => {
    const ids = await seed('org_a');
    const del = withTenant(db, 'org_a', (tx) =>
      tx.delete(message).where(eq(message.id, ids.messageId)),
    );
    await expect(del.catch(pgMessage)).resolves.toMatch(/permission denied/);
    const updated = await withTenant(db, 'org_a', (tx) =>
      tx.update(message).set({ status: 'sent' }).where(eq(message.id, ids.messageId)).returning(),
    );
    expect(updated).toHaveLength(1);
  });
});

describe('constraints', () => {
  it('a conversation cannot reference another org contact', async () => {
    const ana = await addContact('org_a', '+12025550101');
    const attempt = withTenant(db, 'org_b', (tx) =>
      tx
        .insert(conversation)
        .values({ organizationId: 'org_b', contactId: ana.id, channel: 'sms' }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/foreign key/);
  });

  it('rejects a duplicate (org, contact, channel) conversation', async () => {
    const ids = await seed('org_a');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(conversation)
        .values({ organizationId: 'org_a', contactId: ids.contactId, channel: 'sms' }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/unique/);
  });

  it('template names are unique case-insensitively among active templates only', async () => {
    await seed('org_a');
    const dup = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(messageTemplate)
        .values({ organizationId: 'org_a', name: 'HELLO', channel: 'sms', body: 'x' }),
    );
    await expect(dup.catch(pgMessage)).resolves.toMatch(/unique/);
    await withTenant(db, 'org_a', (tx) =>
      tx.update(messageTemplate).set({ archivedAt: new Date() }),
    );
    const again = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(messageTemplate)
        .values({ organizationId: 'org_a', name: 'HELLO', channel: 'sms', body: 'x' })
        .returning(),
    );
    expect(again).toHaveLength(1);
  });

  it('rejects duplicate provider message ids and client message ids per org', async () => {
    const ids = await seed('org_a');
    const base = {
      organizationId: 'org_a',
      conversationId: ids.conversationId,
      contactId: ids.contactId,
      channel: 'sms' as const,
      direction: 'inbound' as const,
      body: 'x',
      status: 'received' as const,
      provider: 'fake' as const,
      occurredAt: new Date(),
    };
    await withTenant(db, 'org_a', (tx) =>
      tx.insert(message).values({ ...base, providerMessageId: 'p1', clientMessageId: 'c1' }),
    );
    const dupProvider = withTenant(db, 'org_a', (tx) =>
      tx.insert(message).values({ ...base, providerMessageId: 'p1' }),
    );
    await expect(dupProvider.catch(pgMessage)).resolves.toMatch(/unique/);
    const dupClient = withTenant(db, 'org_a', (tx) =>
      tx.insert(message).values({ ...base, clientMessageId: 'c1' }),
    );
    await expect(dupClient.catch(pgMessage)).resolves.toMatch(/unique/);
  });

  it.each([
    ['status', { status: 'teleported' }],
    ['direction', { direction: 'sideways' }],
    ['channel', { channel: 'fax' }],
    ['provider', { provider: 'carrier-pigeon' }],
  ])('message rejects an invalid %s', async (_, override) => {
    const ids = await seed('org_a');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx.insert(message).values({
        organizationId: 'org_a',
        conversationId: ids.conversationId,
        contactId: ids.contactId,
        channel: 'sms',
        direction: 'inbound',
        body: 'x',
        status: 'received',
        provider: 'fake',
        occurredAt: new Date(),
        ...override,
      } as never),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });

  it('rejects a negative unread count and an invalid registration status', async () => {
    const ids = await seed('org_a');
    const unread = withTenant(db, 'org_a', (tx) =>
      tx
        .update(conversation)
        .set({ unreadCount: -1 })
        .where(eq(conversation.id, ids.conversationId)),
    );
    await expect(unread.catch(pgMessage)).resolves.toMatch(/check constraint/);
    const reg = withTenant(db, 'org_a', (tx) =>
      tx
        .update(channelConnection)
        .set({ registrationStatus: 'maybe' as never })
        .where(eq(channelConnection.id, ids.connectionId)),
    );
    await expect(reg.catch(pgMessage)).resolves.toMatch(/check constraint/);
  });

  it('allows one connection per org and channel', async () => {
    await seed('org_a');
    const attempt = withTenant(db, 'org_a', (tx) =>
      tx
        .insert(channelConnection)
        .values({ organizationId: 'org_a', channel: 'sms', provider: 'fake', address: 'other' }),
    );
    await expect(attempt.catch(pgMessage)).resolves.toMatch(/unique/);
  });

  it('deleting a contact cascades through conversations, messages and events', async () => {
    const ids = await seed('org_a');
    await withTenant(db, 'org_a', (tx) => tx.delete(contact).where(eq(contact.id, ids.contactId)));
    expect(await admin.db.select().from(conversation)).toHaveLength(0);
    expect(await admin.db.select().from(message)).toHaveLength(0);
    expect(await admin.db.select().from(messageStatusEvent)).toHaveLength(0);
  });
});

describe('permission source', () => {
  it('accepts inbound_start', async () => {
    const ana = await addContact('org_a', '+12025550101');
    const rows = await withTenant(db, 'org_a', (tx) =>
      tx
        .insert(contactPermissionEvent)
        .values({
          organizationId: 'org_a',
          contactId: ana.id,
          channel: 'sms',
          status: 'granted',
          source: 'inbound_start',
        })
        .returning(),
    );
    expect(rows).toHaveLength(1);
  });
});

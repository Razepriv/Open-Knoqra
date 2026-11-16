import { CHANNELS, newId, PERMISSION_STATUSES } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

export const PERMISSION_SOURCES = [
  'manual',
  'import',
  'inbound_stop',
  'inbound_start',
  'merge',
  'system',
] as const;
export type PermissionSource = (typeof PERMISSION_SOURCES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * Append-only consent history. Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 * The only allowed update is merge re-pointing contact_id.
 */
export const contactPermissionEvent = pgTable(
  'contact_permission_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('cp')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull(),
    channel: text('channel', { enum: CHANNELS }).notNull(),
    status: text('status', { enum: PERMISSION_STATUSES }).notNull(),
    source: text('source', { enum: PERMISSION_SOURCES }).notNull(),
    evidence: text('evidence'),
    actorUserId: text('actor_user_id'),
    createdAt: createdAt(),
  },
  (table) => [
    // Tenant-scoped FK: a row can only reference a contact of its own organization, and FK
    // cascades cannot cross tenants.
    foreignKey({
      name: 'contact_permission_event_contact_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    check('contact_permission_event_channel_check', sql`${table.channel} in (${inList(CHANNELS)})`),
    check(
      'contact_permission_event_status_check',
      sql`${table.status} in (${inList(PERMISSION_STATUSES)})`,
    ),
    check(
      'contact_permission_event_source_check',
      sql`${table.source} in (${inList(PERMISSION_SOURCES)})`,
    ),
    check('contact_permission_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    index('contact_permission_event_contact_channel_idx').on(
      table.contactId,
      table.channel,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);

export type ContactPermissionEvent = typeof contactPermissionEvent.$inferSelect;
export type NewContactPermissionEvent = typeof contactPermissionEvent.$inferInsert;

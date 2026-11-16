import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

export const TIMELINE_KINDS = ['note', 'consent', 'system', 'call', 'message', 'task'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/**
 * Append-only contact timeline. Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 * The only allowed update is merge re-pointing contact_id.
 */
export const timelineEvent = pgTable(
  'timeline_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('te')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull(),
    kind: text('kind', { enum: TIMELINE_KINDS }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    actorUserId: text('actor_user_id'),
    source: text('source').notNull().default('app'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    // Tenant-scoped FK: a row can only reference a contact of its own organization, and FK
    // cascades cannot cross tenants.
    foreignKey({
      name: 'timeline_event_contact_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    check(
      'timeline_event_kind_check',
      sql`${table.kind} in ('note', 'consent', 'system', 'call', 'message', 'task')`,
    ),
    check('timeline_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    index('timeline_event_contact_occurred_idx').on(
      table.contactId,
      table.occurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    // Thread notes: the inbox thread pages notes by (ref_type 'conversation', ref_id), newest
    // first (M6c adds the order columns, so a page reads only its rows). No contact_id here: a
    // merge re-points timeline rows to the target contact.
    index('timeline_event_conversation_ref_idx')
      .on(
        table.organizationId,
        table.refId,
        table.occurredAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`${table.refType} = 'conversation'`),
  ],
);

export type TimelineEventRow = typeof timelineEvent.$inferSelect;
export type NewTimelineEvent = typeof timelineEvent.$inferInsert;

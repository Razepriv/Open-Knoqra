import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { createdAt } from './columns';

export const NOTIFICATION_KINDS = ['task_due', 'task_reminder', 'system'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * In-app notification. Append-only except read_at (the app role may update only that column,
 * see sql/rls.sql). Tenant-owned: ENABLE + FORCE row-level security.
 */
export const notification = pgTable(
  'notification',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('nt')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    check('notification_kind_check', sql`${table.kind} in ('task_due', 'task_reminder', 'system')`),
    check('notification_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    unique('notification_dedupe_unique').on(table.organizationId, table.userId, table.dedupeKey),
    index('notification_user_created_idx').on(
      table.organizationId,
      table.userId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
  ],
);

export type NotificationRow = typeof notification.$inferSelect;
export type NewNotification = typeof notification.$inferInsert;

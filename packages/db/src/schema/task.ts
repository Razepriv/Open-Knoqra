import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization, user } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

export const TASK_STATUSES = ['open', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A to-do owned by one user, optionally about a contact. Mutable and deletable.
 * Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 */
export const task = pgTable(
  'task',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('tk')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Nullable: with MATCH SIMPLE the composite FK below is skipped while contact_id is null.
    contactId: text('contact_id'),
    title: text('title').notNull(),
    notes: text('notes'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    remindAt: timestamp('remind_at', { withTimezone: true }),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Stored generated sort key (ruling R1, migration 0012): the open list orders and pages by
    // coalesce(due_at, 'infinity'), an expression an index cannot serve under RLS. The column holds
    // exactly that value, so comparing it returns what the expression did.
    // Query-only: use it in WHERE and ORDER BY, never as a value. A null due_at reads back as
    // 'infinity', which the driver maps to an Invalid Date; read `dueAt` for the due date.
    dueKey: timestamp('due_key', { withTimezone: true })
      .notNull()
      .generatedAlwaysAs(sql`coalesce(due_at, 'infinity'::timestamptz)`),
  },
  (table) => [
    foreignKey({
      name: 'task_contact_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    check('task_status_check', sql`${table.status} in ('open', 'done')`),
    check(
      'task_completed_at_check',
      sql`(${table.status} = 'done') = (${table.completedAt} is not null)`,
    ),
    check('task_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    index('task_owner_status_due_idx').on(
      table.organizationId,
      table.ownerUserId,
      table.status,
      table.dueAt,
    ),
    index('task_owner_completed_idx').on(
      table.organizationId,
      table.ownerUserId,
      table.completedAt,
    ),
    // M6c: the open list's keyset order, per owner and per contact, and the reminder poll.
    index('task_owner_order_idx').on(
      table.organizationId,
      table.ownerUserId,
      table.status,
      table.dueKey,
      table.createdAt,
      table.id,
    ),
    index('task_contact_order_idx').on(
      table.organizationId,
      table.contactId,
      table.status,
      table.dueKey,
      table.createdAt,
      table.id,
    ),
    index('task_owner_remind_idx').on(
      table.organizationId,
      table.ownerUserId,
      table.status,
      table.remindAt,
    ),
  ],
);

export type TaskRow = typeof task.$inferSelect;
export type NewTask = typeof task.$inferInsert;

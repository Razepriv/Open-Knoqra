import { SETUP_STEPS } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { organization } from './auth';

/**
 * Per-user first-run setup progress. Tenant-owned: forced RLS (sql/rls.sql). test_call_id is a
 * composite FK to call ON DELETE SET NULL (test_call_id): raw SQL in migration 0005 (Drizzle cannot
 * express the PG15+ column-list form), so no FK is declared on that column here.
 */
export const setupProgress = pgTable(
  'setup_progress',
  {
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    lastStep: text('last_step', { enum: SETUP_STEPS }),
    audioCheckedAt: timestamp('audio_checked_at', { withTimezone: true }),
    testCallId: text('test_call_id'),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ name: 'setup_progress_pk', columns: [table.organizationId, table.userId] }),
    check(
      'setup_progress_last_step_check',
      sql`${table.lastStep} is null or ${table.lastStep} in ('connect', 'number', 'audio', 'test_call')`,
    ),
    check('setup_progress_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type SetupProgressRow = typeof setupProgress.$inferSelect;
export type NewSetupProgress = typeof setupProgress.$inferInsert;

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const CRON_STATUSES = ['running', 'ok', 'error'] as const;
export type CronStatus = (typeof CRON_STATUSES)[number];

/**
 * System table, deliberately NOT under row-level security (no organization_id): one row per
 * scheduled job, recording its latest run for the health check.
 */
export const cronRun = pgTable(
  'cron_run',
  {
    name: text('name').primaryKey(),
    lastStartedAt: timestamp('last_started_at', { withTimezone: true }).notNull(),
    lastFinishedAt: timestamp('last_finished_at', { withTimezone: true }),
    lastStatus: text('last_status', { enum: CRON_STATUSES }).notNull(),
    lastDurationMs: integer('last_duration_ms'),
  },
  (table) => [
    check('cron_run_last_status_check', sql`${table.lastStatus} in ('running', 'ok', 'error')`),
  ],
);

export type CronRun = typeof cronRun.$inferSelect;
export type NewCronRun = typeof cronRun.$inferInsert;

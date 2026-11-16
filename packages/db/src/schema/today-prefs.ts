import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * Per-user Today page preferences. No organization_id, so no RLS: user-scoped, and only ever read
 * through the session user id.
 */
export const userTodayPrefs = pgTable(
  'user_today_prefs',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    dailyGoal: integer('daily_goal').notNull().default(6),
    widgetOrder: text('widget_order').array().notNull().default(sql`'{}'::text[]`),
    hiddenWidgets: text('hidden_widgets').array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [check('user_today_prefs_daily_goal_check', sql`${table.dailyGoal} between 1 and 12`)],
);

export type UserTodayPrefs = typeof userTodayPrefs.$inferSelect;
export type NewUserTodayPrefs = typeof userTodayPrefs.$inferInsert;

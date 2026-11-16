import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * Per-user preferences. No organization_id, so no RLS: user-scoped, and only ever read through the
 * session user id.
 */
export const userPrefs = pgTable(
  'user_prefs',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    timezone: text('timezone'),
    theme: text('theme', { enum: THEMES }).notNull().default('system'),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifyDesktop: boolean('notify_desktop').notNull().default(true),
    analyticsConsent: boolean('analytics_consent').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [check('user_prefs_theme_check', sql`${table.theme} in ('system', 'light', 'dark')`)],
);

export type UserPrefs = typeof userPrefs.$inferSelect;
export type NewUserPrefs = typeof userPrefs.$inferInsert;

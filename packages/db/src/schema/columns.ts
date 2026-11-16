import { timestamp } from 'drizzle-orm/pg-core';

/** `timestamptz not null default now()`. */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

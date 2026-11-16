import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const PROVIDER_EVENT_STATUSES = [
  'pending',
  'processed',
  'ignored',
  'parked',
  'dead_lettered',
] as const;
export type ProviderEventStatus = (typeof PROVIDER_EVENT_STATUSES)[number];

/**
 * System table, deliberately NOT under row-level security: raw inbound provider webhooks are
 * stored before the owning organization is resolved. Never expose it through tenant queries.
 */
export const providerEventRaw = pgTable(
  'provider_event_raw',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('pe')),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    body: jsonb('body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    status: text('status', { enum: PROVIDER_EVENT_STATUSES }).notNull().default('pending'),
    parkReason: text('park_reason'),
    attempts: integer('attempts').notNull().default(0),
    /**
     * Set when the event came through a connection's own webhook URL and was verified with that
     * workspace's key: the event may only change that organization. Null for the platform URL.
     */
    organizationId: text('organization_id'),
  },
  (table) => [
    unique('provider_event_raw_provider_external_event_id_unique').on(
      table.provider,
      table.externalEventId,
    ),
    check(
      'provider_event_raw_status_check',
      sql`${table.status} in ('pending', 'processed', 'ignored', 'parked', 'dead_lettered')`,
    ),
    // Backs the webhook-lag health query (oldest unprocessed event).
    index('provider_event_raw_unprocessed_idx')
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
  ],
);

export type ProviderEventRaw = typeof providerEventRaw.$inferSelect;
export type NewProviderEventRaw = typeof providerEventRaw.$inferInsert;

import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt } from './columns';

export const USAGE_SERVICES = ['voice', 'sms', 'whatsapp', 'ai'] as const;
export type UsageService = (typeof USAGE_SERVICES)[number];

/**
 * Generic metered-usage ledger row. Append-only (the app role cannot update or delete). No FK to
 * organization, like audit_event, so money rows outlive what they describe.
 * Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 */
export const usageEvent = pgTable(
  'usage_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ue')),
    organizationId: text('organization_id').notNull(),
    userId: text('user_id'),
    service: text('service', { enum: USAGE_SERVICES }).notNull(),
    quantity: integer('quantity').notNull(),
    unit: text('unit').notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    provider: text('provider').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    check('usage_event_service_check', sql`${table.service} in ('voice', 'sms', 'whatsapp', 'ai')`),
    check('usage_event_quantity_check', sql`${table.quantity} >= 0`),
    check('usage_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    unique('usage_event_idempotency_unique').on(table.organizationId, table.idempotencyKey),
    index('usage_event_org_service_occurred_idx').on(
      table.organizationId,
      table.service,
      table.occurredAt,
    ),
  ],
);

export type UsageEventRow = typeof usageEvent.$inferSelect;
export type NewUsageEvent = typeof usageEvent.$inferInsert;

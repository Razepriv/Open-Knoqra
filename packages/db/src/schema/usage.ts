import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { ledgerEntry } from './ledger';

/** Append-only provider balance reads (insert/read for the app role). Forced RLS. */
export const providerBalanceSnapshot = pgTable(
  'provider_balance_snapshot',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('bs')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status', { enum: ['ok', 'auth_failed', 'unavailable'] }).notNull(),
    balanceMicros: bigint('balance_micros', { mode: 'number' }),
    currency: text('currency', { enum: ['USD'] }).notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('provider_balance_snapshot_org_captured_idx').on(
      table.organizationId,
      table.capturedAt.desc(),
    ),
    check(
      'provider_balance_snapshot_status_check',
      sql`${table.status} in ('ok', 'auth_failed', 'unavailable')`,
    ),
    check('provider_balance_snapshot_currency_check', sql`${table.currency} in ('USD')`),
    check(
      'provider_balance_snapshot_balance_check',
      sql`(${table.status} = 'ok') = (${table.balanceMicros} is not null)`,
    ),
    check(
      'provider_balance_snapshot_organization_id_not_empty',
      sql`${table.organizationId} <> ''`,
    ),
  ],
);

/** Append-only provider-reported usage lines. Forced RLS. */
export const providerUsageRecord = pgTable(
  'provider_usage_record',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('pu')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    service: text('service', { enum: ['voice', 'sms', 'whatsapp'] }).notNull(),
    quantity: integer('quantity'),
    unit: text('unit'),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    providerRef: text('provider_ref').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('provider_usage_record_org_provider_ref_unique').on(
      table.organizationId,
      table.provider,
      table.providerRef,
    ),
    index('provider_usage_record_org_occurred_idx').on(table.organizationId, table.occurredAt),
    check(
      'provider_usage_record_service_check',
      sql`${table.service} in ('voice', 'sms', 'whatsapp')`,
    ),
    check('provider_usage_record_cost_check', sql`${table.costMicros} >= 0`),
    check('provider_usage_record_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/** Append-only reconciliation outcomes. Forced RLS. */
export const reconciliationReport = pgTable(
  'reconciliation_report',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('rc')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    periodDate: date('period_date', { mode: 'string' }).notNull(),
    service: text('service', { enum: ['voice'] }).notNull(),
    trigger: text('trigger', { enum: ['cron', 'manual'] }).notNull(),
    status: text('status', {
      enum: ['matched', 'adjusted', 'needs_review', 'provider_unavailable'],
    }).notNull(),
    capturedMicros: bigint('captured_micros', { mode: 'number' }).notNull(),
    providerMicros: bigint('provider_micros', { mode: 'number' }),
    ledgerMicros: bigint('ledger_micros', { mode: 'number' }).notNull(),
    driftMicros: bigint('drift_micros', { mode: 'number' }).notNull(),
    adjustEntryId: text('adjust_entry_id'),
    actorUserId: text('actor_user_id'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'reconciliation_report_adjust_entry_fk',
      columns: [table.organizationId, table.adjustEntryId],
      foreignColumns: [ledgerEntry.organizationId, ledgerEntry.id],
    }),
    index('reconciliation_report_org_created_idx').on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check('reconciliation_report_service_check', sql`${table.service} in ('voice')`),
    check('reconciliation_report_trigger_check', sql`${table.trigger} in ('cron', 'manual')`),
    check(
      'reconciliation_report_status_check',
      sql`${table.status} in ('matched', 'adjusted', 'needs_review', 'provider_unavailable')`,
    ),
    check(
      'reconciliation_report_adjusted_check',
      sql`(${table.status} = 'adjusted') = (${table.adjustEntryId} is not null)`,
    ),
    check('reconciliation_report_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type ProviderBalanceSnapshotRow = typeof providerBalanceSnapshot.$inferSelect;
export type NewProviderBalanceSnapshot = typeof providerBalanceSnapshot.$inferInsert;
export type ProviderUsageRecordRow = typeof providerUsageRecord.$inferSelect;
export type NewProviderUsageRecord = typeof providerUsageRecord.$inferInsert;
export type ReconciliationReportRow = typeof reconciliationReport.$inferSelect;
export type NewReconciliationReport = typeof reconciliationReport.$inferInsert;

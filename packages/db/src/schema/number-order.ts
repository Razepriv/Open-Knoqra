import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { ledgerEntry } from './ledger';

/**
 * A server-side price for one number, read fresh from the provider. Valid until `expiresAt`, used
 * by at most one order. Append-only for the app role. Tenant-owned: forced RLS (sql/rls.sql).
 */
export const numberQuote = pgTable(
  'number_quote',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('nq')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['fake', 'telnyx', 'plivo'] }).notNull(),
    e164: text('e164').notNull(),
    upfrontMicros: bigint('upfront_micros', { mode: 'number' }).notNull(),
    monthlyMicros: bigint('monthly_micros', { mode: 'number' }).notNull(),
    currency: text('currency', { enum: ['USD'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('number_quote_organization_id_id_unique').on(table.organizationId, table.id),
    check('number_quote_provider_check', sql`${table.provider} in ('fake', 'telnyx', 'plivo')`),
    check('number_quote_upfront_check', sql`${table.upfrontMicros} >= 0`),
    check('number_quote_monthly_check', sql`${table.monthlyMicros} >= 0`),
    check('number_quote_currency_check', sql`${table.currency} in ('USD')`),
    check('number_quote_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/**
 * One purchase of a quoted number. The charge is a ledger reservation, captured or released when
 * the provider answers. A free order (both prices 0, for example a number a plan includes) holds
 * nothing and has no reservation. The app role may only update the outcome columns (sql/rls.sql).
 */
export const numberOrder = pgTable(
  'number_order',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('no')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    quoteId: text('quote_id').notNull().unique(),
    provider: text('provider', { enum: ['fake', 'telnyx', 'plivo'] }).notNull(),
    e164: text('e164').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: ['pending', 'completed', 'failed'] }).notNull(),
    providerOrderId: text('provider_order_id'),
    upfrontMicros: bigint('upfront_micros', { mode: 'number' }).notNull(),
    monthlyMicros: bigint('monthly_micros', { mode: 'number' }).notNull(),
    /** Null only for a free order. */
    reservationId: text('reservation_id'),
    failureCode: text('failure_code'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('number_order_organization_id_idempotency_key_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'number_order_quote_fk',
      columns: [table.organizationId, table.quoteId],
      foreignColumns: [numberQuote.organizationId, numberQuote.id],
    }),
    foreignKey({
      name: 'number_order_reservation_fk',
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [ledgerEntry.organizationId, ledgerEntry.id],
    }),
    index('number_order_org_created_idx').on(table.organizationId, table.createdAt.desc()),
    // One open (pending or completed) order per number in an organization: a second purchase of
    // the same number cannot be held, so a sync never captures two orders for one number.
    uniqueIndex('number_order_open_e164_unique')
      .on(table.organizationId, table.e164)
      .where(sql`${table.status} <> 'failed'`),
    check('number_order_provider_check', sql`${table.provider} in ('fake', 'telnyx', 'plivo')`),
    check('number_order_status_check', sql`${table.status} in ('pending', 'completed', 'failed')`),
    check('number_order_upfront_check', sql`${table.upfrontMicros} >= 0`),
    check('number_order_monthly_check', sql`${table.monthlyMicros} >= 0`),
    check('number_order_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    check(
      'number_order_free_or_held',
      sql`${table.reservationId} is not null or (${table.upfrontMicros} = 0 and ${table.monthlyMicros} = 0)`,
    ),
  ],
);

export type NumberQuoteRow = typeof numberQuote.$inferSelect;
export type NumberOrderRow = typeof numberOrder.$inferSelect;

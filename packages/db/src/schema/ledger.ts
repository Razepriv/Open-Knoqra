import { LEDGER_KINDS, newId } from '@knoqra/core';
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

/**
 * One wallet per organization. Money is integer micros (1 USD = 1,000,000). The caps are
 * calendar-month (UTC) spend caps, null = off. Tenant-owned: forced RLS (sql/rls.sql).
 */
export const wallet = pgTable(
  'wallet',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('wl')),
    organizationId: text('organization_id')
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: 'cascade' }),
    currency: text('currency', { enum: ['USD'] })
      .notNull()
      .default('USD'),
    warnCapMicros: bigint('warn_cap_micros', { mode: 'number' }),
    stopCapMicros: bigint('stop_cap_micros', { mode: 'number' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('wallet_organization_id_id_unique').on(table.organizationId, table.id),
    check('wallet_currency_check', sql`${table.currency} in ('USD')`),
    check(
      'wallet_caps_ordered',
      sql`${table.warnCapMicros} is null or ${table.stopCapMicros} is null or ${table.warnCapMicros} <= ${table.stopCapMicros}`,
    ),
    check('wallet_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/**
 * Append-only ledger of balance and held (reserved) micros. The app role may only insert and read
 * (sql/rls.sql). Each reservation is closed by at most one capture or release.
 */
export const ledgerEntry = pgTable(
  'ledger_entry',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('le')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    walletId: text('wallet_id').notNull(),
    kind: text('kind', { enum: LEDGER_KINDS }).notNull(),
    balanceDeltaMicros: bigint('balance_delta_micros', { mode: 'number' }).notNull(),
    heldDeltaMicros: bigint('held_delta_micros', { mode: 'number' }).notNull(),
    reservationId: text('reservation_id'),
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    note: text('note'),
    actorUserId: text('actor_user_id'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('ledger_entry_organization_id_id_unique').on(table.organizationId, table.id),
    unique('ledger_entry_organization_id_idempotency_key_unique').on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex('ledger_entry_reservation_close_unique')
      .on(table.reservationId)
      .where(sql`${table.kind} in ('capture', 'release')`),
    // A call's holds (the one at the start and any added mid-call), so its end can close them all.
    index('ledger_entry_call_hold_idx')
      .on(table.organizationId, table.refId)
      .where(sql`${table.kind} = 'reserve' and ${table.refType} = 'call'`),
    foreignKey({
      name: 'ledger_entry_wallet_fk',
      columns: [table.organizationId, table.walletId],
      foreignColumns: [wallet.organizationId, wallet.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ledger_entry_reservation_fk',
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [table.organizationId, table.id],
    }),
    check(
      'ledger_entry_kind_check',
      sql`${table.kind} in ('credit', 'adjust', 'reserve', 'capture', 'release', 'fee')`,
    ),
    check(
      'ledger_entry_kind_signs',
      sql`(${table.kind} = 'reserve' and ${table.balanceDeltaMicros} = 0 and ${table.heldDeltaMicros} > 0 and ${table.reservationId} is null)
        or (${table.kind} = 'capture' and ${table.balanceDeltaMicros} <= 0 and ${table.heldDeltaMicros} < 0 and ${table.reservationId} is not null)
        or (${table.kind} = 'release' and ${table.balanceDeltaMicros} = 0 and ${table.heldDeltaMicros} < 0 and ${table.reservationId} is not null)
        or (${table.kind} = 'credit' and ${table.balanceDeltaMicros} > 0 and ${table.heldDeltaMicros} = 0)
        or (${table.kind} = 'adjust' and ${table.heldDeltaMicros} = 0)
        or (${table.kind} = 'fee' and ${table.balanceDeltaMicros} < 0 and ${table.heldDeltaMicros} = 0 and ${table.reservationId} is null)`,
    ),
    check('ledger_entry_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type WalletRow = typeof wallet.$inferSelect;
export type NewWallet = typeof wallet.$inferInsert;
export type LedgerEntryRow = typeof ledgerEntry.$inferSelect;
export type NewLedgerEntry = typeof ledgerEntry.$inferInsert;

import { newId, TEN_DLC_STATES, WHATSAPP_STATES } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/** A provider phone number owned by an organization. Tenant-owned: forced RLS (sql/rls.sql). */
export const phoneNumber = pgTable(
  'phone_number',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('pn')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['fake', 'telnyx', 'plivo'] }).notNull(),
    providerNumberId: text('provider_number_id').notNull(),
    e164: text('e164').notNull(),
    status: text('status', { enum: ['active', 'pending', 'inactive'] }).notNull(),
    voice: boolean('voice').notNull(),
    sms: boolean('sms').notNull(),
    mms: boolean('mms').notNull(),
    whatsapp: boolean('whatsapp').notNull(),
    tenDlcStatus: text('ten_dlc_status', { enum: TEN_DLC_STATES }).notNull(),
    whatsappStatus: text('whatsapp_status', { enum: WHATSAPP_STATES }).notNull(),
    assignedUse: text('assigned_use', {
      enum: ['unassigned', 'calls', 'messages', 'calls_and_messages'],
    })
      .notNull()
      .default('unassigned'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('phone_number_organization_id_id_unique').on(table.organizationId, table.id),
    unique('phone_number_org_provider_number_unique').on(
      table.organizationId,
      table.provider,
      table.providerNumberId,
    ),
    unique('phone_number_org_e164_unique').on(table.organizationId, table.e164),
    check('phone_number_provider_check', sql`${table.provider} in ('fake', 'telnyx', 'plivo')`),
    check('phone_number_status_check', sql`${table.status} in ('active', 'pending', 'inactive')`),
    check(
      'phone_number_ten_dlc_status_check',
      sql`${table.tenDlcStatus} in (${quoted(TEN_DLC_STATES)})`,
    ),
    check(
      'phone_number_whatsapp_status_check',
      sql`${table.whatsappStatus} in (${quoted(WHATSAPP_STATES)})`,
    ),
    check(
      'phone_number_assigned_use_check',
      sql`${table.assignedUse} in ('unassigned', 'calls', 'messages', 'calls_and_messages')`,
    ),
    check('phone_number_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type PhoneNumberRow = typeof phoneNumber.$inferSelect;
export type NewPhoneNumber = typeof phoneNumber.$inferInsert;

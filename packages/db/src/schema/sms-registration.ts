import { newId, SMS_ENTITY_TYPES, SMS_REGISTRATION_STATES } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A workspace's US texting (10DLC) registration, made with its own provider account: the details
 * it submitted, the provider's ids for each step and where it stands. One per workspace; a new
 * submission replaces a failed or rejected one. Tenant-owned: forced RLS (sql/rls.sql).
 */
export const smsRegistration = pgTable(
  'sms_registration',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('sr')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['telnyx'] }).notNull(),
    entityType: text('entity_type', { enum: SMS_ENTITY_TYPES }).notNull(),
    /** The number being registered, E.164. */
    phoneE164: text('phone_e164').notNull(),
    /** The submitted business details and compliance texts (core `SmsRegistrationDetails`). */
    details: jsonb('details').notNull(),
    state: text('state', { enum: SMS_REGISTRATION_STATES }).notNull().default('submitting'),
    messagingProfileId: text('messaging_profile_id'),
    brandId: text('brand_id'),
    brandStatus: text('brand_status'),
    campaignId: text('campaign_id'),
    campaignStatus: text('campaign_status'),
    assignmentStatus: text('assignment_status'),
    /** Why the last step failed or was rejected: the provider's reason, never a key or a body. */
    failureReason: text('failure_reason'),
    createdBy: text('created_by'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('sms_registration_organization_id_unique').on(table.organizationId),
    check('sms_registration_provider_check', sql`${table.provider} in ('telnyx')`),
    check(
      'sms_registration_entity_type_check',
      sql`${table.entityType} in (${quoted(SMS_ENTITY_TYPES)})`,
    ),
    check(
      'sms_registration_state_check',
      sql`${table.state} in (${quoted(SMS_REGISTRATION_STATES)})`,
    ),
    check('sms_registration_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type SmsRegistrationRow = typeof smsRegistration.$inferSelect;

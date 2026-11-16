import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';

/** The real providers a workspace can connect (`@knoqra/providers` registry ids). */
export const CONNECTOR_PROVIDERS = ['telnyx', 'plivo'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

/**
 * A workspace's one telephony connection (its connector): the provider's secret, envelope-encrypted
 * (AES-GCM, wrapped DEK), plus the provider's non-secret ids. One row per organization. Tenant-owned:
 * ENABLE + FORCE row-level security (sql/rls.sql). Ciphertext never leaves the API.
 *
 * Per provider: `api_key_*` seals the Telnyx API key or the Plivo auth token. `connection_id` is the
 * Telnyx credential connection or the Plivo application. `account_id` is the Plivo Auth ID (null
 * for Telnyx). `webhook_public_key` is the Telnyx account's webhook public key, base64 (not
 * secret; null for Plivo, whose webhooks are checked with the auth token).
 */
export const providerCredential = pgTable(
  'provider_credential',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('pc')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: CONNECTOR_PROVIDERS }).notNull(),
    apiKeyCiphertext: text('api_key_ciphertext').notNull(),
    apiKeyIv: text('api_key_iv').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),
    dekIv: text('dek_iv').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    apiKeyLast4: text('api_key_last4').notNull(),
    connectionId: text('connection_id'),
    accountId: text('account_id'),
    webhookPublicKey: text('webhook_public_key'),
    telephonyCredentialId: text('telephony_credential_id'),
    callerIdE164: text('caller_id_e164'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One connector per workspace: calls, numbers, the balance poll and reconciliation all read it.
    unique('provider_credential_organization_id_unique').on(table.organizationId),
    check('provider_credential_provider_check', sql`${table.provider} in ('telnyx', 'plivo')`),
    check('provider_credential_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type ProviderCredentialRow = typeof providerCredential.$inferSelect;
export type NewProviderCredential = typeof providerCredential.$inferInsert;

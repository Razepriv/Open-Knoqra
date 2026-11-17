import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';

/** How a workspace connected Otto to a model. */
export const AI_CREDENTIAL_KINDS = ['api_key', 'chatgpt'] as const;
export type AiCredentialKind = (typeof AI_CREDENTIAL_KINDS)[number];

/**
 * A workspace's own connection for Otto: an OpenAI API key, or (behind a feature flag) the tokens
 * of a "Sign in with ChatGPT". One row per organization. The secret is envelope-encrypted with the
 * credentials master key (AES-GCM, wrapped DEK), like `provider_credential`; for `chatgpt` it seals
 * the token set as JSON. Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql). Ciphertext
 * never leaves the API, and the key is never shown again: the Desk sees its last four characters.
 */
export const aiCredential = pgTable(
  'ai_credential',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ac')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: AI_CREDENTIAL_KINDS }).notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretIv: text('secret_iv').notNull(),
    dekWrapped: text('dek_wrapped').notNull(),
    dekIv: text('dek_iv').notNull(),
    keyFingerprint: text('key_fingerprint').notNull(),
    /** The API key's last four characters; null for a ChatGPT sign-in. */
    secretLast4: text('secret_last4'),
    /** The model to use; null means the default. */
    model: text('model'),
    /** When a ChatGPT access token stops working; null for an API key. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('ai_credential_organization_id_unique').on(table.organizationId),
    check('ai_credential_kind_check', sql`${table.kind} in ('api_key', 'chatgpt')`),
    check('ai_credential_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type AiCredentialRow = typeof aiCredential.$inferSelect;

import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

export const OTTO_DRAFT_KINDS = ['draft', 'brief', 'digest'] as const;
export type OttoDraftKind = (typeof OTTO_DRAFT_KINDS)[number];
export const OTTO_CHANNELS = ['sms', 'whatsapp'] as const;
export type OttoChannel = (typeof OTTO_CHANNELS)[number];

export interface OttoCitation {
  ref: string;
  kind: 'contact' | 'timeline' | 'task' | 'notification';
  label: string;
}

/**
 * Text Otto produced for a user. Append-only (the app role cannot update or delete, see
 * sql/rls.sql). Tenant-owned: ENABLE + FORCE row-level security.
 */
export const ottoDraft = pgTable(
  'otto_draft',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('od')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind', { enum: OTTO_DRAFT_KINDS }).notNull(),
    contactId: text('contact_id'),
    channel: text('channel', { enum: OTTO_CHANNELS }),
    instruction: text('instruction'),
    text: text('text').notNull(),
    citations: jsonb('citations').$type<OttoCitation[]>().notNull().default(sql`'[]'::jsonb`),
    provider: text('provider').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'otto_draft_contact_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    check('otto_draft_kind_check', sql`${table.kind} in ('draft', 'brief', 'digest')`),
    check(
      'otto_draft_channel_check',
      sql`${table.channel} is null or ${table.channel} in ('sms', 'whatsapp')`,
    ),
    check('otto_draft_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type OttoDraftRow = typeof ottoDraft.$inferSelect;
export type NewOttoDraft = typeof ottoDraft.$inferInsert;

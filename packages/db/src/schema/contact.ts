import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';

/** Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql). */
export const contact = pgTable(
  'contact',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ct')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    company: text('company'),
    phoneE164: text('phone_e164').notNull(),
    timezone: text('timezone'),
    source: text('source').notNull().default('manual'),
    email: text('email'),
    jobTitle: text('job_title'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    sourceDetail: text('source_detail'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Composite FK (organization_id, merged_into_id) -> contact ON DELETE SET NULL (merged_into_id)
    // is raw SQL in migration 0003: Drizzle cannot express the PG15+ column-list SET NULL.
    mergedIntoId: text('merged_into_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // Stored generated keys (ruling R1, migration 0012). Under RLS Postgres only uses leakproof
    // comparisons as index conditions, and lower()/ILIKE/regexp_replace are not leakproof, so the
    // hot queries compare these plain columns instead. Each value is exactly what the queries
    // computed inline before: the list keyset, duplicate name and email keys, and search text.
    sortName: text('sort_name').notNull().generatedAlwaysAs(sql`lower(display_name)`),
    nameKey: text('name_key')
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim(regexp_replace(display_name, '\\s+', ' ', 'g')))`),
    emailKey: text('email_key').generatedAlwaysAs(sql`lower(email)`),
    // U+001F joins the fields: safeText rejects C0 controls, so a match never spans two fields.
    searchText: text('search_text')
      .notNull()
      .generatedAlwaysAs(
        sql`lower(display_name) || E'\\x1f' || lower(coalesce(company, '')) || E'\\x1f' || lower(coalesce(email, ''))`,
      ),
  },
  (table) => [
    // Target of the tenant-scoped composite foreign keys from history tables.
    unique('contact_organization_id_id_unique').on(table.organizationId, table.id),
    // One unmerged contact per number. A merged source gives its number up, so the target (or a
    // new contact) can take it; an archived contact keeps it until restored or merged.
    uniqueIndex('contact_organization_id_phone_e164_unique')
      .on(table.organizationId, table.phoneE164)
      .where(sql`merged_into_id is null`),
    // '' is what app.org_id reverts to after a tenant transaction; it must never be a tenant.
    check('contact_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    // The partial predicates repeat the list route's archivedCondition so the planner can prove
    // the query implies them.
    index('contact_active_sort_idx')
      .on(table.organizationId, table.sortName, table.id)
      .where(sql`archived_at is null and merged_into_id is null`),
    index('contact_inactive_sort_idx')
      .on(table.organizationId, table.sortName, table.id)
      .where(sql`archived_at is not null or merged_into_id is not null`),
    index('contact_active_name_key_idx')
      .on(table.organizationId, table.nameKey)
      .where(sql`archived_at is null and merged_into_id is null`),
    index('contact_active_email_key_idx')
      .on(table.organizationId, table.emailKey)
      .where(sql`archived_at is null and merged_into_id is null and email_key is not null`),
  ],
);

export type Contact = typeof contact.$inferSelect;
export type NewContact = typeof contact.$inferInsert;

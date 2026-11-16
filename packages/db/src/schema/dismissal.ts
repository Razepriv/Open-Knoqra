import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

/**
 * A pair of contacts the user marked "not duplicates". Pairs are stored ordered (a < b).
 * Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 */
export const contactDuplicateDismissal = pgTable(
  'contact_duplicate_dismissal',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('dd')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    contactAId: text('contact_a_id').notNull(),
    contactBId: text('contact_b_id').notNull(),
    dismissedBy: text('dismissed_by'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'contact_duplicate_dismissal_contact_a_fk',
      columns: [table.organizationId, table.contactAId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'contact_duplicate_dismissal_contact_b_fk',
      columns: [table.organizationId, table.contactBId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    // COLLATE "C": byte order, independent of the database collation, matches JS code-unit sort.
    check(
      'contact_duplicate_dismissal_ordered',
      sql`${table.contactAId} COLLATE "C" < ${table.contactBId} COLLATE "C"`,
    ),
    index('contact_duplicate_dismissal_org_b_idx').on(table.organizationId, table.contactBId),
    check(
      'contact_duplicate_dismissal_organization_id_not_empty',
      sql`${table.organizationId} <> ''`,
    ),
    unique('contact_duplicate_dismissal_pair_unique').on(
      table.organizationId,
      table.contactAId,
      table.contactBId,
    ),
  ],
);

export type ContactDuplicateDismissal = typeof contactDuplicateDismissal.$inferSelect;
export type NewContactDuplicateDismissal = typeof contactDuplicateDismissal.$inferInsert;

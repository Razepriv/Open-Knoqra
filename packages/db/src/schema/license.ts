import { sql } from 'drizzle-orm';
import { check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * System table, deliberately NOT under row-level security: the license key a self-hosted instance
 * runs under. One row (id = 1) for the whole instance, not tenant data. The key is signed and
 * public-key verified on every read, so the row holds nothing secret. Never joined to tenant data.
 */
export const instanceLicense = pgTable(
  'instance_license',
  {
    id: smallint('id').primaryKey().default(1),
    licenseKey: text('license_key').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [check('instance_license_single_row', sql`${table.id} = 1`)],
);

export type InstanceLicenseRow = typeof instanceLicense.$inferSelect;

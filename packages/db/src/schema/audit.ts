import { newId } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';

export const AUDIT_OUTCOMES = ['allowed', 'denied', 'not_found'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Tenant-owned: ENABLE + FORCE row-level security (sql/rls.sql).
 * No foreign key to organization: audit rows must outlive the rows they describe.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ae')),
    organizationId: text('organization_id').notNull(),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    outcome: text('outcome', { enum: AUDIT_OUTCOMES }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    check('audit_event_outcome_check', sql`${table.outcome} in ('allowed', 'denied', 'not_found')`),
    // '' is what app.org_id reverts to after a tenant transaction; it must never be a tenant.
    check('audit_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    index('audit_event_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
  ],
);

export type AuditEvent = typeof auditEvent.$inferSelect;
export type NewAuditEvent = typeof auditEvent.$inferInsert;

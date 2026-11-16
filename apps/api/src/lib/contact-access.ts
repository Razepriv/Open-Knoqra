import { z } from '@hono/zod-openapi';
import {
  type AuditOutcome,
  auditEvent,
  type Contact,
  contact,
  type Database,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Tenant } from './context';
import { fail } from './envelope';

export const CONTACT_ID_PATTERN = /^ct_[0-9a-f]{32}$/;

export const ContactIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export type ContactAuditAction =
  | 'contact.create'
  | 'contact.read'
  | 'contact.update'
  | 'contact.archive'
  | 'contact.restore'
  | 'contact.timeline.read'
  | 'contact.note.create'
  | 'contact.permission.read'
  | 'contact.permission.change'
  | 'contact.permission.do_not_contact'
  | 'contact.duplicates.read'
  | 'contact.duplicate.dismiss'
  | 'contact.merge'
  | 'contact.import';

interface ContactAuditInput {
  action: ContactAuditAction;
  outcome: AuditOutcome;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export function insertContactAudit(tx: Tx, tenant: Tenant, input: ContactAuditInput) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'contact',
    action: input.action,
    outcome: input.outcome,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** Audits in its own tenant transaction (for outcomes where no write transaction committed). */
export function auditContactAlone(db: Database, tenant: Tenant, input: ContactAuditInput) {
  return withTenant(db, tenant.orgId, (tx) => insertContactAudit(tx, tenant, input));
}

export type ContactAccess =
  | { kind: 'ok'; row: Contact }
  | { kind: 'not_found' }
  | { kind: 'archived' }
  | { kind: 'merged' };

/** Finds the contact in the tenant tx (RLS-scoped); `lock` takes the row lock for writes. */
export async function findContact(tx: Tx, id: string, lock: boolean): Promise<Contact | undefined> {
  const query = tx.select().from(contact).where(eq(contact.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/** Classifies a contact for a write: merged and archived contacts are read-only. */
export function writableAccess(row: Contact | undefined): ContactAccess {
  if (!row) return { kind: 'not_found' };
  if (row.mergedIntoId) return { kind: 'merged' };
  if (row.archivedAt) return { kind: 'archived' };
  return { kind: 'ok', row };
}

/** 404 for a malformed id, still audited (null entityId) so probing stays visible. */
export async function rejectMalformedContactId(
  c: Context,
  db: Database,
  tenant: Tenant,
  action: ContactAuditAction,
) {
  await auditContactAlone(db, tenant, {
    action,
    outcome: 'not_found',
    metadata: { reason: 'malformed_id' },
  });
  return fail(c, 404, 'not_found', 'Contact not found.');
}

export async function notFound(
  c: Context,
  db: Database,
  tenant: Tenant,
  action: ContactAuditAction,
  id: string,
) {
  await auditContactAlone(db, tenant, { action, outcome: 'not_found', entityId: id });
  return fail(c, 404, 'not_found', 'Contact not found.');
}

/** Response for a refused write (audits the refusal): 404 when missing, else 422. */
export async function refuseAccess(
  c: Context,
  db: Database,
  tenant: Tenant,
  action: ContactAuditAction,
  id: string,
  kind: 'not_found' | 'archived' | 'merged',
) {
  if (kind === 'not_found') return notFound(c, db, tenant, action, id);
  await auditContactAlone(db, tenant, {
    action,
    outcome: 'denied',
    entityId: id,
    metadata: { reason: kind },
  });
  return fail(
    c,
    422,
    'validation_error',
    kind === 'merged' ? 'Merged contacts cannot be edited' : 'Restore this contact first',
  );
}

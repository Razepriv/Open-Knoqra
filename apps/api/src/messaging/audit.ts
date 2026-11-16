import { type AuditOutcome, auditEvent, type Database, type Tx, withTenant } from '@knoqra/db';
import type { Tenant } from '../lib/context';

export type MessagingAuditAction =
  | 'conversation.create'
  | 'conversation.read'
  | 'conversation.note.create'
  | 'message.send'
  | 'message.read'
  | 'template.create'
  | 'template.archive'
  | 'template.approve'
  | 'template.reset_approval'
  | 'sandbox.update'
  | 'sender.update';

export interface MessagingAuditInput {
  action: MessagingAuditAction;
  entityType: 'conversation' | 'message' | 'message_template' | 'channel_connection';
  outcome: AuditOutcome;
  entityId?: string | null;
  /** Never message bodies or phone numbers. */
  metadata?: Record<string, unknown>;
}

export function insertMessagingAudit(tx: Tx, tenant: Tenant, input: MessagingAuditInput) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: input.entityType,
    action: input.action,
    outcome: input.outcome,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** Audits in its own tenant transaction (for outcomes where no write transaction committed). */
export function auditMessagingAlone(db: Database, tenant: Tenant, input: MessagingAuditInput) {
  return withTenant(db, tenant.orgId, (tx) => insertMessagingAudit(tx, tenant, input));
}

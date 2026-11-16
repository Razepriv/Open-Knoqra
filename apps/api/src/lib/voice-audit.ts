import { type AuditOutcome, auditEvent, type Database, type Tx, withTenant } from '@knoqra/db';
import type { Tenant } from './context';

export type VoiceAuditAction =
  | 'voice.connection.update'
  | 'voice.connection.delete'
  | 'voice.token.create';

interface VoiceAuditInput {
  action: VoiceAuditAction;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/** Never put a key, token or ciphertext in `metadata`. */
export function insertVoiceAudit(tx: Tx, tenant: Tenant, input: VoiceAuditInput) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'voice',
    action: input.action,
    outcome: input.outcome,
    entityId: null,
    metadata: input.metadata ?? {},
  });
}

/** Audits in its own tenant transaction (for refusals where no write transaction committed). */
export function auditVoiceAlone(db: Database, tenant: Tenant, input: VoiceAuditInput) {
  return withTenant(db, tenant.orgId, (tx) => insertVoiceAudit(tx, tenant, input));
}

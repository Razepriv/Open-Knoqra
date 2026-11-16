import { type AuditOutcome, auditEvent, type Database, type Tx, withTenant } from '@knoqra/db';
import type { Tenant } from './context';

export type CallAuditAction =
  | 'call.create'
  | 'call.read'
  | 'call.cancel'
  | 'call.answer'
  | 'call.outcome';

export type WalletAuditAction = 'wallet.caps.update' | 'wallet.credit.create';

export type VoicemailAuditAction = 'voicemail.listened';

interface AuditInput {
  action: CallAuditAction | WalletAuditAction | VoicemailAuditAction;
  outcome: AuditOutcome;
  entityId?: string | null;
  /** Never phone numbers, notes or any other PII: ids, enums and amounts only. */
  metadata?: Record<string, unknown>;
}

const entityTypeOf = (action: AuditInput['action']) => {
  if (action.startsWith('wallet.')) return 'wallet';
  if (action.startsWith('voicemail.')) return 'voicemail';
  return 'call';
};

export function insertCallAudit(tx: Tx, tenant: Tenant, input: AuditInput) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: entityTypeOf(input.action),
    action: input.action,
    outcome: input.outcome,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** Audits in its own tenant transaction (for refusals where no write transaction committed). */
export function auditCallAlone(db: Database, tenant: Tenant, input: AuditInput) {
  return withTenant(db, tenant.orgId, (tx) => insertCallAudit(tx, tenant, input));
}

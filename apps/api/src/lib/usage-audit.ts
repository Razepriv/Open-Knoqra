import { type AuditOutcome, auditEvent, type Database, type Tx, withTenant } from '@knoqra/db';
import type { Tenant } from './context';

export type UsageAuditAction =
  | 'numbers.sync'
  | 'numbers.assign'
  | 'numbers.search'
  | 'numbers.quote'
  | 'numbers.purchase'
  | 'numbers.orders'
  | 'setup.update'
  | 'usage.balance.refresh'
  | 'ledger.reconcile';

interface UsageAuditInput {
  action: UsageAuditAction;
  outcome: AuditOutcome;
  entityType: string;
  entityId?: string | null;
  /** Required when `tenant` is null (a cron actor). */
  orgId?: string;
  /** The acting user when `tenant` is null (a manual run); cron leaves it unset. */
  actorUserId?: string | null;
  /**
   * Ids, counts and enums only: never a key or a provider message, and never a number except the
   * e164 of `numbers.purchase`, which names what was bought.
   */
  metadata?: Record<string, unknown>;
}

/** A null tenant is a cron actor: `actorUserId` is null and `input.orgId` names the organization. */
export function insertUsageAudit(tx: Tx, tenant: Tenant | null, input: UsageAuditInput) {
  const orgId = tenant?.orgId ?? input.orgId;
  if (!orgId) throw new Error('insertUsageAudit needs a tenant or an orgId');
  return tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: tenant?.userId ?? input.actorUserId ?? null,
    entityType: input.entityType,
    action: input.action,
    outcome: input.outcome,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** Audits in its own tenant transaction (for refusals where no write transaction committed). */
export function auditUsageAlone(db: Database, tenant: Tenant, input: UsageAuditInput) {
  return withTenant(db, tenant.orgId, (tx) => insertUsageAudit(tx, tenant, input));
}

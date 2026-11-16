import { auditEvent, type Tx } from '@knoqra/db';
import type { Tenant } from './context';

export type UserAuditAction =
  | 'user.prefs.update'
  | 'user.profile.update'
  | 'user.today_prefs.update';

/**
 * Audits a change to the signed-in user's own data under their active organization. The user is
 * not tenant data, but the audit table is. Metadata holds changed field names only, never values.
 */
export function insertUserAudit(tx: Tx, tenant: Tenant, action: UserAuditAction, fields: string[]) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'user',
    action,
    outcome: 'allowed',
    entityId: tenant.userId,
    metadata: { fields: [...fields].sort() },
  });
}

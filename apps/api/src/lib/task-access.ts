import { z } from '@hono/zod-openapi';
import { type AuditOutcome, auditEvent, type Database, type Tx, withTenant } from '@knoqra/db';
import type { Context } from 'hono';
import type { Tenant } from './context';
import { fail } from './envelope';

export const TASK_ID_PATTERN = /^tk_[0-9a-f]{32}$/;

export const TaskIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export type TaskAuditAction =
  | 'task.create'
  | 'task.update'
  | 'task.complete'
  | 'task.reopen'
  | 'task.delete';

interface TaskAuditInput {
  action: TaskAuditAction;
  outcome: AuditOutcome;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Never put a title or notes in `metadata`: they are PII. */
export function insertTaskAudit(tx: Tx, tenant: Tenant, input: TaskAuditInput) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'task',
    action: input.action,
    outcome: input.outcome,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** 404 for a malformed, missing, foreign-org or other-user task, audited as not_found. */
export async function taskNotFound(
  c: Context,
  db: Database,
  tenant: Tenant,
  action: TaskAuditAction,
  id: string,
  malformed = false,
) {
  await withTenant(db, tenant.orgId, (tx) =>
    insertTaskAudit(tx, tenant, {
      action,
      outcome: 'not_found',
      entityId: malformed ? null : id,
      metadata: malformed ? { reason: 'malformed_id' } : {},
    }),
  );
  return fail(c, 404, 'not_found', 'Task not found.');
}

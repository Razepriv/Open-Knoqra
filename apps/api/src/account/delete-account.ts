import {
  account,
  auditEvent,
  type Database,
  member,
  type Tx,
  user,
  userPrefs,
  verification,
} from '@knoqra/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Auth } from '../auth/auth';
import { announceNewsletterChange, type NewsletterChange } from '../email/newsletter';
import type { Env } from '../env';
import type { ApiExtension } from '../extensions';
import { logger } from '../lib/logger';
import { storageKey } from '../messaging/attachments';

/**
 * Account deletion (`DELETE /api/v1/me`). The signed-in user confirms with their password, then:
 *
 * - a workspace where they are the only member is closed: its data is removed and the money records
 *   the law requires are kept, anonymised (`knoqra_close_workspace` in packages/db/sql/rls.sql);
 * - a workspace with another owner keeps its data, and the user simply leaves it;
 * - a workspace where they are the only owner but others are members blocks the deletion, because
 *   closing it would delete other people's work.
 *
 * The user row goes last and takes their sessions, sign-in methods, memberships, preferences and
 * notifications with it (all cascade). Other tables keep only the bare user id, which no longer
 * points at anyone.
 */
export interface DeletionPlan {
  /** Workspaces the user is the only member of. */
  close: string[];
  /** Workspaces with another owner: the user leaves and the data stays with the workspace. */
  leave: string[];
  /** Workspaces where the user is the only owner of a team. */
  blocked: string[];
}

/** Roles may hold several comma-separated values (Better Auth's member.role). */
export function hasOwnerRole(role: string): boolean {
  return role
    .split(',')
    .map((r) => r.trim())
    .includes('owner');
}

export async function deletionPlan(db: Database, userId: string): Promise<DeletionPlan> {
  const memberships = await db
    .select({ orgId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId));
  const plan: DeletionPlan = { close: [], leave: [], blocked: [] };
  for (const { orgId, role } of memberships) {
    const others = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), ne(member.userId, userId)));
    if (others.length === 0) plan.close.push(orgId);
    else if (!hasOwnerRole(role) || others.some((o) => hasOwnerRole(o.role)))
      plan.leave.push(orgId);
    else plan.blocked.push(orgId);
  }
  return plan;
}

/** Whether `password` is the user's sign-in password (their email-and-password account). */
export async function passwordMatches(
  auth: Auth,
  db: Database,
  userId: string,
  password: string,
): Promise<boolean> {
  const [row] = await db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .limit(1);
  if (!row?.hash) return false;
  const context = await auth.$context;
  return context.password.verify({ hash: row.hash, password });
}

/**
 * Runs each extension's `beforeWorkspaceClose` (cancel a subscription, stop renewals) for every
 * workspace that will close, and returns which must keep provider access. Throws when an extension
 * does: nothing has been deleted at that point.
 */
export async function prepareWorkspaceClosures(
  env: Env,
  db: Database,
  extensions: readonly ApiExtension[],
  orgIds: readonly string[],
): Promise<Map<string, boolean>> {
  const keep = new Map<string, boolean>();
  for (const orgId of orgIds) {
    let keepProviderAccess = false;
    for (const extension of extensions) {
      const result = await extension.beforeWorkspaceClose?.(env, db, orgId);
      if (result?.keepProviderAccess) keepProviderAccess = true;
    }
    keep.set(orgId, keepProviderAccess);
  }
  return keep;
}

async function enterTenant(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}

/** The audit row each affected workspace keeps: the user id and what happened, no other data. */
function auditDeletion(tx: Tx, orgId: string, userId: string, workspace: 'closed' | 'left') {
  return tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    entityType: 'user',
    action: 'user.account.delete',
    outcome: 'allowed',
    entityId: userId,
    metadata: { workspace },
  });
}

/** Closes and leaves the planned workspaces and deletes the user, in one transaction. */
export async function deleteAccount(
  db: Database,
  extensions: readonly ApiExtension[],
  userId: string,
  plan: DeletionPlan,
  keepProviderAccess: ReadonlyMap<string, boolean>,
): Promise<void> {
  if (plan.blocked.length > 0) throw new Error('deleteAccount: the plan has blocked workspaces');
  await db.transaction(async (tx) => {
    for (const orgId of plan.close) {
      await enterTenant(tx, orgId);
      for (const extension of extensions) await extension.closeWorkspace?.(tx, orgId);
      const keep = keepProviderAccess.get(orgId) ?? false;
      await tx.execute(sql`select public.knoqra_close_workspace(${orgId}, ${keep})`);
      await auditDeletion(tx, orgId, userId, 'closed');
    }
    for (const orgId of plan.leave) {
      await enterTenant(tx, orgId);
      await auditDeletion(tx, orgId, userId, 'left');
    }
    // Password-reset and similar tokens hold the user id as their value.
    await tx.delete(verification).where(eq(verification.value, userId));
    await tx.delete(user).where(eq(user.id, userId));
  });
}

/** The newsletter change to announce when the deleted user was subscribed, read before deletion. */
export async function newsletterLeaveFor(
  db: Database,
  who: { id: string; email: string; name: string },
): Promise<NewsletterChange | null> {
  const [prefs] = await db
    .select({ newsletter: userPrefs.newsletter })
    .from(userPrefs)
    .where(eq(userPrefs.userId, who.id))
    .limit(1);
  if (!prefs?.newsletter) return null;
  return {
    userId: who.id,
    email: who.email,
    name: who.name,
    subscribed: false,
    source: 'account-deleted',
  };
}

/** Deletes every stored file of a closed workspace (message media lives under `org/<id>/`). */
async function deleteWorkspaceMedia(bucket: R2Bucket, orgId: string): Promise<void> {
  const prefix = storageKey(orgId, '');
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * After the deletion committed: removes the closed workspaces' stored files and takes the user off
 * the mailing list. Never throws; failures are logged without personal data.
 */
export async function afterAccountDeleted(
  env: Env,
  closed: readonly string[],
  newsletter: NewsletterChange | null,
): Promise<void> {
  const bucket = env.MEDIA;
  if (bucket) {
    for (const orgId of closed) {
      try {
        await deleteWorkspaceMedia(bucket, orgId);
      } catch (error) {
        logger.warn('account.delete_media_failed', {
          organizationId: orgId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  }
  if (newsletter) await announceNewsletterChange(env, newsletter);
}

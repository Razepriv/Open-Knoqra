import { type Database, member, organization, session, user } from '@knoqra/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { logger } from '../lib/logger';

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 32 alphanumeric characters, the shape of Better Auth's default ids. Unbiased: bytes >= 248 are skipped. */
export function authStyleId(): string {
  let id = '';
  while (id.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(40))) {
      if (byte < 248 && id.length < 32) id += ID_ALPHABET.charAt(byte % 62);
    }
  }
  return id;
}

export function workspaceName(userName: string): string {
  return `${userName}'s workspace`;
}

export function workspaceSlug(userId: string): string {
  return `ws-${userId.toLowerCase()}`;
}

export interface WorkspaceOwner {
  id: string;
  name: string;
}

/**
 * Makes sure the user owns their personal workspace and returns its id, or null (see below). Idempotent and safe to
 * retry: the org is keyed by the deterministic `ws-<user id>` slug, the owner row is added only
 * when missing, and the org row is locked so concurrent calls for one user serialize.
 *
 * It also points the user's sessions that have no active organization at the workspace (sign-up
 * creates its session before Better Auth runs `user.create.after` hooks).
 *
 * Returns null, changing nothing, when an existing `ws-<user id>` org has other members: joining an
 * organization other people use must take an invitation, never a slug match.
 */
export async function ensurePersonalWorkspace(
  db: Database,
  user: WorkspaceOwner,
): Promise<string | null> {
  const slug = workspaceSlug(user.id);
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx
      .insert(organization)
      .values({ id: authStyleId(), name: workspaceName(user.name), slug, createdAt: now })
      .onConflictDoNothing({ target: organization.slug });
    const [org] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, slug))
      .for('update');
    if (!org) throw new Error('personal workspace missing after insert');

    const members = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, org.id));
    if (members.some((m) => m.userId !== user.id)) {
      logger.warn('workspace.slug_has_other_members', { organizationId: org.id, userId: user.id });
      return null;
    }
    if (members.length === 0) {
      await tx.insert(member).values({
        id: authStyleId(),
        organizationId: org.id,
        userId: user.id,
        role: 'owner',
        createdAt: now,
      });
    }

    await tx
      .update(session)
      .set({ activeOrganizationId: org.id })
      .where(and(eq(session.userId, user.id), isNull(session.activeOrganizationId)));
    return org.id;
  });
}

/**
 * The organization a new session should start in: the user's oldest membership. A user with no
 * membership at all (for example, after a failed sign-up hook) gets their personal workspace back.
 * Null leaves the session without an organization, so requests get 409 no_active_org.
 */
export async function initialOrganizationId(db: Database, userId: string): Promise<string | null> {
  const existing = await firstMembershipOrgId(db, userId);
  if (existing) return existing;
  const [owner] = await db
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!owner) throw new Error('session created for an unknown user');
  return ensurePersonalWorkspace(db, owner);
}

/** The organization of the user's oldest membership, or null when the user belongs to none. */
export async function firstMembershipOrgId(db: Database, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  return row?.organizationId ?? null;
}

/** The user's role in `orgId`, or null when the user is not a member. */
export async function membershipRole(
  db: Database,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1);
  return row?.role ?? null;
}

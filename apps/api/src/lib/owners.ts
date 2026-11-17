import { member, type Tx } from '@knoqra/db';
import { and, eq, sql } from 'drizzle-orm';

/** The user ids of the workspace's owners (RLS-scoped `tx`). A role may list several, comma-separated. */
export async function workspaceOwnerIds(tx: Tx, orgId: string): Promise<string[]> {
  const owners = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, orgId),
        sql`'owner' = any(string_to_array(replace(${member.role}, ' ', ''), ','))`,
      ),
    );
  return owners.map((o) => o.userId);
}

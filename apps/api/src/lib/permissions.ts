import { type ContactPermissionEvent, contactPermissionEvent, type Tx } from '@knoqra/db';
import { desc, inArray } from 'drizzle-orm';

/**
 * Latest event per channel, by the same (created_at, id) order `currentPermissions` uses. With
 * several ids, the latest across all of them: the order the combined history will have.
 *
 * Consent invariant: any writer that changes consent must hold the contact row lock
 * (`findContact(tx, id, true)`) and timestamp with `clock_timestamp()`, never `now()`.
 * Readers pass only the latest event per channel (as here) to `currentPermissions`, not history.
 */
export function latestPermissionEvents(
  tx: Tx,
  ...contactIds: [string, ...string[]]
): Promise<ContactPermissionEvent[]> {
  return tx
    .selectDistinctOn([contactPermissionEvent.channel])
    .from(contactPermissionEvent)
    .where(inArray(contactPermissionEvent.contactId, contactIds))
    .orderBy(
      contactPermissionEvent.channel,
      desc(contactPermissionEvent.createdAt),
      desc(contactPermissionEvent.id),
    );
}

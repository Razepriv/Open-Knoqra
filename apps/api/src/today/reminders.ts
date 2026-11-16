import { notification, type Tx, task } from '@knoqra/db';
import { and, eq, isNotNull, lte, notExists, type SQL, sql } from 'drizzle-orm';

interface ReminderScope {
  orgId: string;
  userId: string;
}

/**
 * The dedupe key `prefix:<task id>:<Date#toISOString()>` built in SQL, so a poll can skip tasks
 * whose notification already exists instead of re-sending every one to a conflicting insert.
 * `to_char` in UTC with milliseconds matches `toISOString()`. If it ever did not, the filter
 * would only stop filtering: the insert below still uses the key built in JavaScript.
 */
export function dedupeKeySql(prefix: 'reminder' | 'due', at: SQL): SQL {
  return sql`${prefix} || ':' || ${task.id} || ':' || to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function notMaterialized(tx: Tx, scope: ReminderScope, key: SQL): SQL {
  return notExists(
    tx
      .select({ one: sql`1` })
      .from(notification)
      .where(
        and(
          eq(notification.organizationId, scope.orgId),
          eq(notification.userId, scope.userId),
          sql`${notification.dedupeKey} = ${key}`,
        ),
      ),
  );
}

/**
 * Turns the user's open tasks whose remind or due time has passed into notifications. Safe to
 * call on every read: the unique (org, user, dedupe_key) index makes a repeat or a concurrent
 * call a no-op. Keys carry the stored timestamp, so rescheduling creates exactly one new entry.
 * Returns the number of rows created.
 */
export async function materializeReminders(
  tx: Tx,
  scope: ReminderScope,
  now: Date,
): Promise<number> {
  const open = and(
    eq(task.organizationId, scope.orgId),
    eq(task.ownerUserId, scope.userId),
    eq(task.status, 'open'),
  );
  const [reminders, overdue] = await Promise.all([
    tx
      .select({ id: task.id, title: task.title, at: task.remindAt })
      .from(task)
      .where(
        and(
          open,
          isNotNull(task.remindAt),
          lte(task.remindAt, now),
          notMaterialized(tx, scope, dedupeKeySql('reminder', sql`${task.remindAt}`)),
        ),
      ),
    tx
      .select({ id: task.id, title: task.title, at: task.dueAt })
      .from(task)
      .where(
        and(
          open,
          isNotNull(task.dueAt),
          lte(task.dueAt, now),
          notMaterialized(tx, scope, dedupeKeySql('due', sql`${task.dueAt}`)),
        ),
      ),
  ]);
  const base = { organizationId: scope.orgId, userId: scope.userId, refType: 'task' } as const;
  const values: (typeof notification.$inferInsert)[] = [];
  for (const r of reminders) {
    if (!r.at) continue;
    values.push({
      ...base,
      kind: 'task_reminder',
      title: `Reminder: ${r.title}`,
      refId: r.id,
      dedupeKey: `reminder:${r.id}:${r.at.toISOString()}`,
    });
  }
  for (const r of overdue) {
    if (!r.at) continue;
    values.push({
      ...base,
      kind: 'task_due',
      title: `Overdue: ${r.title}`,
      refId: r.id,
      dedupeKey: `due:${r.id}:${r.at.toISOString()}`,
    });
  }
  if (values.length === 0) return 0;
  // One lock order for every caller: two concurrent polls insert the same keys in the same order,
  // so they wait on each other instead of deadlocking.
  const ordered = [...values].sort((a, b) =>
    a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0,
  );
  const inserted = await tx
    .insert(notification)
    .values(ordered)
    .onConflictDoNothing({
      target: [notification.organizationId, notification.userId, notification.dedupeKey],
    })
    .returning({ id: notification.id });
  return inserted.length;
}

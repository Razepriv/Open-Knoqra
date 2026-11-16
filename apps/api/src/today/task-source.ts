import type { DayKey } from '@knoqra/core';
import { type Tx, task } from '@knoqra/db';
import { and, eq, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { ActivityEntry, ActivityScope, ActivitySource, DayRange } from './activity-sources';

type Column = typeof task.completedAt | typeof task.dueAt;

const localDay = (column: Column, tz: string) =>
  sql<string>`to_char(${column} at time zone ${tz}, 'YYYY-MM-DD')`;
const localRange = (column: Column, tz: string, range: DayRange): SQL =>
  sql`${column} >= (${range.from}::date - 1)::timestamptz and ${column} < (${range.to}::date + 2)::timestamptz and (${column} at time zone ${tz})::date between ${range.from}::date and ${range.to}::date`;

/** A completed task is an outcome (by completed_at); an open task due in range is a plain entry. */
export const taskSource: ActivitySource = {
  name: 'tasks',

  async outcomeCounts(tx: Tx, scope: ActivityScope, range: DayRange) {
    const rows = await tx
      .select({
        day: localDay(task.completedAt, scope.timeZone),
        count: sql<number>`count(*)::int`,
      })
      .from(task)
      .where(
        and(
          eq(task.ownerUserId, scope.userId),
          isNotNull(task.completedAt),
          localRange(task.completedAt, scope.timeZone, range),
        ),
      )
      .groupBy(sql`1`);
    return new Map<DayKey, number>(rows.map((r) => [r.day, r.count]));
  },

  async entries(tx: Tx, scope: ActivityScope, range: DayRange) {
    const tz = scope.timeZone;
    const rows = await tx
      .select({
        id: task.id,
        title: task.title,
        contactId: task.contactId,
        status: task.status,
        dueAt: task.dueAt,
        completedAt: task.completedAt,
        dueDay: localDay(task.dueAt, tz),
        doneDay: localDay(task.completedAt, tz),
        dueTime: sql<string>`to_char(${task.dueAt} at time zone ${tz}, 'HH24:MI')`,
      })
      .from(task)
      .where(
        and(
          eq(task.ownerUserId, scope.userId),
          or(
            and(eq(task.status, 'open'), localRange(task.dueAt, tz, range)),
            and(isNotNull(task.completedAt), localRange(task.completedAt, tz, range)),
          ),
        ),
      );
    const entries: ActivityEntry[] = [];
    for (const row of rows) {
      if (row.status === 'done' && row.completedAt) {
        entries.push({
          at: row.completedAt,
          day: row.doneDay,
          contactId: row.contactId,
          kind: 'task_done',
          label: `Done · ${row.title}`,
          refType: 'task',
          refId: row.id,
          outcome: true,
        });
      } else if (row.status === 'open' && row.dueAt) {
        entries.push({
          at: row.dueAt,
          day: row.dueDay,
          contactId: row.contactId,
          kind: 'task_due',
          label: `Due ${row.dueTime} · ${row.title}`,
          refType: 'task',
          refId: row.id,
          outcome: false,
        });
      }
    }
    return entries;
  },
};

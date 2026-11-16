import type { DayKey } from '@knoqra/core';
import { type Tx, timelineEvent } from '@knoqra/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ActivityEntry, ActivityScope, ActivitySource, DayRange } from './activity-sources';

const OUTCOME_KINDS = ['note', 'call', 'message'] as const;
const ENTRY_KINDS = ['note', 'call', 'message', 'consent'] as const;
const LABELS = {
  note: 'Note',
  call: 'Call',
  message: 'Message',
  consent: 'Consent updated',
} as const;

const dayOf = (tz: string) =>
  sql<string>`to_char(${timelineEvent.occurredAt} at time zone ${tz}, 'YYYY-MM-DD')`;
// The first two bounds are sargable (any zone is within a day of UTC); the third is exact.
const inRange = (tz: string, range: DayRange) =>
  sql`${timelineEvent.occurredAt} >= (${range.from}::date - 1)::timestamptz and ${timelineEvent.occurredAt} < (${range.to}::date + 2)::timestamptz and (${timelineEvent.occurredAt} at time zone ${tz})::date between ${range.from}::date and ${range.to}::date`;

/**
 * Counts and the `outcome` flag cover only notes, calls and messages the user made. Entries show
 * every actor's note, call, message and consent event (inbound ones have no actor). `task` and
 * `system` rows never appear: tasks are counted once, in task-source.
 */
export const timelineSource: ActivitySource = {
  name: 'timeline',

  async outcomeCounts(tx: Tx, scope: ActivityScope, range: DayRange) {
    const rows = await tx
      .select({ day: dayOf(scope.timeZone), count: sql<number>`count(*)::int` })
      .from(timelineEvent)
      .where(
        and(
          eq(timelineEvent.actorUserId, scope.userId),
          inArray(timelineEvent.kind, [...OUTCOME_KINDS]),
          inRange(scope.timeZone, range),
        ),
      )
      .groupBy(sql`1`);
    return new Map<DayKey, number>(rows.map((r) => [r.day, r.count]));
  },

  async entries(tx: Tx, scope: ActivityScope, range: DayRange) {
    const rows = await tx
      .select({
        id: timelineEvent.id,
        contactId: timelineEvent.contactId,
        kind: timelineEvent.kind,
        actorUserId: timelineEvent.actorUserId,
        at: timelineEvent.occurredAt,
        day: dayOf(scope.timeZone),
      })
      .from(timelineEvent)
      .where(and(inArray(timelineEvent.kind, [...ENTRY_KINDS]), inRange(scope.timeZone, range)));
    const entries: ActivityEntry[] = [];
    for (const row of rows) {
      if (row.kind === 'task' || row.kind === 'system') continue;
      entries.push({
        at: row.at,
        day: row.day,
        contactId: row.contactId,
        kind: row.kind,
        label: LABELS[row.kind],
        refType: 'timeline_event',
        refId: row.id,
        outcome: row.kind !== 'consent' && row.actorUserId === scope.userId,
      });
    }
    return entries;
  },
};

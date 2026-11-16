import type { DayKey } from '@knoqra/core';
import type { Tx } from '@knoqra/db';
import { taskSource } from './task-source';
import { timelineSource } from './timeline-source';

export interface ActivityScope {
  orgId: string;
  userId: string;
  timeZone: string;
}
/** Inclusive, in `scope.timeZone`. */
export interface DayRange {
  from: DayKey;
  to: DayKey;
}
export interface ActivityEntry {
  at: Date;
  day: DayKey;
  contactId: string | null;
  kind: 'call' | 'message' | 'note' | 'consent' | 'task_due' | 'task_done';
  label: string;
  refType: string;
  refId: string;
  outcome: boolean;
}
export interface ActivitySource {
  readonly name: string;
  outcomeCounts(tx: Tx, scope: ActivityScope, range: DayRange): Promise<Map<DayKey, number>>;
  entries(tx: Tx, scope: ActivityScope, range: DayRange): Promise<ActivityEntry[]>;
}

/** Everything that counts as an outcome, or shows on the week grid, comes from here. */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [timelineSource, taskSource];

export function sumOutcomeCounts(maps: Map<DayKey, number>[]): Map<DayKey, number> {
  const total = new Map<DayKey, number>();
  for (const map of maps) {
    for (const [day, count] of map) total.set(day, (total.get(day) ?? 0) + count);
  }
  return total;
}

export async function loadOutcomeCounts(
  tx: Tx,
  scope: ActivityScope,
  range: DayRange,
): Promise<Map<DayKey, number>> {
  const maps: Map<DayKey, number>[] = [];
  for (const source of ACTIVITY_SOURCES) maps.push(await source.outcomeCounts(tx, scope, range));
  return sumOutcomeCounts(maps);
}

export async function loadEntries(
  tx: Tx,
  scope: ActivityScope,
  range: DayRange,
): Promise<ActivityEntry[]> {
  const all: ActivityEntry[] = [];
  for (const source of ACTIVITY_SOURCES) all.push(...(await source.entries(tx, scope, range)));
  return all.sort((a, b) => a.at.getTime() - b.at.getTime());
}

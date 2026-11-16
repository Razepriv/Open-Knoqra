import { addDays, type DayKey, isWorkingDay, startOfWeek } from './calendar';

export type HeatLevel = 0 | 1 | 2 | 3 | 4;
export type HeatmapDay = {
  day: DayKey;
  count: number;
  level: HeatLevel;
  state: 'past' | 'today' | 'upcoming';
};
export type HeatmapWeek = { days: HeatmapDay[] };

function previousWorkingDay(day: DayKey): DayKey {
  let d = addDays(day, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

function kept(counts: ReadonlyMap<DayKey, number>, day: DayKey): boolean {
  return (counts.get(day) ?? 0) > 0;
}

/**
 * Working-day streak. Weekend activity never adds to a run and an empty
 * weekend never ends one.
 */
export function computeStreak(
  counts: ReadonlyMap<DayKey, number>,
  today: DayKey,
  earliest: DayKey,
): { current: number; best: number; todayKept: boolean } {
  const todayKept = isWorkingDay(today) && kept(counts, today);

  let current = 0;
  let cursor = todayKept ? today : previousWorkingDay(today);
  while (cursor >= earliest && kept(counts, cursor)) {
    current += 1;
    cursor = previousWorkingDay(cursor);
  }

  let best = 0;
  let run = 0;
  for (let d = earliest; d <= today; d = addDays(d, 1)) {
    if (!isWorkingDay(d)) continue;
    run = kept(counts, d) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return { current, best: Math.max(best, current), todayKept };
}

export function heatLevel(count: number): HeatLevel {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

/** Monday-start week columns, oldest first; the last holds `today`. */
export function buildHeatmap(
  counts: ReadonlyMap<DayKey, number>,
  today: DayKey,
  weeks = 16,
): HeatmapWeek[] {
  const firstMonday = addDays(startOfWeek(today), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, w) => ({
    days: Array.from({ length: 7 }, (_, i): HeatmapDay => {
      const day = addDays(firstMonday, w * 7 + i);
      const count = counts.get(day) ?? 0;
      const state = day === today ? 'today' : day > today ? 'upcoming' : 'past';
      return { day, count, level: heatLevel(count), state };
    }),
  }));
}

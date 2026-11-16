// Words and labels for Today. Day keys (`YYYY-MM-DD`) are already in the user's zone, so every
// helper reads them as plain calendar dates (UTC), never through the browser's own zone.
import { addDays, type DayKey, isWorkingDay } from '@knoqra/core';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface CalendarDate {
  year: number;
  month: string;
  date: number;
  weekday: string;
}

function calendar(day: DayKey): CalendarDate {
  const at = new Date(`${day}T00:00:00Z`);
  return {
    year: at.getUTCFullYear(),
    month: MONTHS[at.getUTCMonth()] ?? '',
    date: at.getUTCDate(),
    weekday: WEEKDAYS[at.getUTCDay()] ?? '',
  };
}

/** "Thursday, 12 November". */
export function dateLine(day: DayKey): string {
  const { weekday, date, month } = calendar(day);
  return `${weekday}, ${date} ${month}`;
}

/** "12 Nov". */
export function shortDate(day: DayKey): string {
  const { date, month } = calendar(day);
  return `${date} ${month.slice(0, 3)}`;
}

/** "9 – 15 November", "26 October – 1 November", or with years when the week crosses one. */
export function weekRangeLabel(start: DayKey): string {
  const first = calendar(start);
  const last = calendar(addDays(start, 6));
  if (first.year !== last.year) {
    return `${first.date} ${first.month} ${first.year} – ${last.date} ${last.month} ${last.year}`;
  }
  if (first.month !== last.month) {
    return `${first.date} ${first.month} – ${last.date} ${last.month}`;
  }
  return `${first.date} – ${last.date} ${last.month}`;
}

/** The column header of a day: "Mon" and 9. */
export function dayHeader(day: DayKey): { weekday: string; date: number } {
  const { weekday, date } = calendar(day);
  return { weekday: weekday.slice(0, 3), date };
}

/** The line under the streak number: kept, still open, or a weekend (which never counts). */
export function streakLine(today: DayKey, streak: { todayKept: boolean; best: number }): string {
  if (streak.todayKept) return `Kept today. Next goal: beat your best run of ${streak.best}.`;
  if (!isWorkingDay(today)) return 'Weekend. Your streak picks up on Monday.';
  return 'Today is open. One logged outcome keeps it going.';
}

/** "0 outcomes", "1 outcome", "2 tasks". */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export interface HeatCell {
  day: DayKey;
  count: number;
  state: 'past' | 'today' | 'upcoming';
}

/** What a heatmap cell says to a screen reader and in its tooltip. */
export function heatCellLabel({ day, count, state }: HeatCell): string {
  if (state === 'upcoming') return `${shortDate(day)} · upcoming`;
  if (state === 'past') {
    return `${shortDate(day)} · ${count === 0 ? 'no outcomes' : countLabel(count, 'outcome')}`;
  }
  if (!isWorkingDay(day)) {
    return count === 0 ? 'Today · weekend' : `Today · ${countLabel(count, 'outcome')}`;
  }
  return count === 0 ? 'Today · pending' : `Today · kept · ${countLabel(count, 'outcome')}`;
}

export interface MonthLabel {
  label: string;
  /** Index of the first week column the label sits over. */
  start: number;
  span: number;
}

/**
 * Month names over the heatmap's week columns: a label starts where a column's Monday falls in a
 * new month. A month with a single column is left unnamed (its label would collide).
 */
export function heatmapMonths(
  weeks: ReadonlyArray<{ days: ReadonlyArray<{ day: DayKey }> }>,
): MonthLabel[] {
  const months = weeks.map((week) => calendar(week.days[0]?.day ?? '1970-01-01').month);
  const labels: MonthLabel[] = [];
  months.forEach((month, index) => {
    if (index > 0 && months[index - 1] === month) {
      const current = labels.at(-1);
      if (current) labels[labels.length - 1] = { ...current, span: current.span + 1 };
      return;
    }
    labels.push({ label: month.slice(0, 3).toUpperCase(), start: index, span: 1 });
  });
  return labels.filter((label) => label.span > 1);
}

const CHIP_WORDS = {
  call: 'Call',
  message: 'Message',
  note: 'Note',
  consent: 'Consent',
  task_done: 'Done',
} as const;

/** The short text on a week-grid chip: "Note", "Done", or a due task's time ("15:00", user's zone). */
export function chipText(
  entry: { kind: keyof typeof CHIP_WORDS | 'task_due'; at: string },
  timeZone: string,
): string {
  if (entry.kind !== 'task_due') return CHIP_WORDS[entry.kind];
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(entry.at));
}

/** The hour (0–23) at `at` in `timeZone`, so the greeting follows the user's zone. */
export function hourIn(at: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(at)
    .find((part) => part.type === 'hour')?.value;
  return Number(hour ?? 0) % 24;
}

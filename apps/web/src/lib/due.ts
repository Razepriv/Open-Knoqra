// Due dates are instants; what "today" means depends on the reader's time zone, so every helper
// takes the zone explicitly.

export type DueGroup = 'overdue' | 'today' | 'upcoming' | 'none';

export interface Dueable {
  dueAt: string | null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MS_PER_DAY = 86_400_000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(at: Date, timeZone: string): ZonedParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const read = (type: string) => Number(formatted.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The calendar day as a number of days since 1970, in `timeZone`. */
function dayNumber(at: Date, timeZone: string): number {
  const { year, month, day } = partsIn(at, timeZone);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

const pad = (value: number): string => String(value).padStart(2, '0');

function clock(at: Date, timeZone: string): string {
  const { hour, minute } = partsIn(at, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** Where `dueAt` sits relative to now: past (overdue), today, later, or without a date. */
export function dueGroup(task: Dueable, now: Date, timeZone: string): DueGroup {
  if (!task.dueAt) return 'none';
  const due = new Date(task.dueAt);
  if (due.getTime() < now.getTime()) return 'overdue';
  return dayNumber(due, timeZone) === dayNumber(now, timeZone) ? 'today' : 'upcoming';
}

/** "Today 15:00", "Tomorrow 09:00", "Fri 13 Nov", "Overdue · 2 days" or "No date". 24-hour clock. */
export function dueLabel(task: Dueable, now: Date, timeZone: string): string {
  if (!task.dueAt) return 'No date';
  const due = new Date(task.dueAt);
  const days = dayNumber(due, timeZone) - dayNumber(now, timeZone);
  if (dueGroup(task, now, timeZone) === 'overdue') {
    if (days === 0) return `Overdue · today ${clock(due, timeZone)}`;
    return `Overdue · ${-days} ${days === -1 ? 'day' : 'days'}`;
  }
  if (days === 0) return `Today ${clock(due, timeZone)}`;
  if (days === 1) return `Tomorrow ${clock(due, timeZone)}`;
  const { year, month, day } = partsIn(due, timeZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${day} ${MONTHS[month - 1]}`;
}

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function offsetMs(at: number, timeZone: string): number {
  const p = partsIn(new Date(at), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A `datetime-local` value read as wall-clock time in `timeZone`, as an ISO instant. */
export function localInputToIso(value: string, timeZone: string): string | null {
  const match = LOCAL_INPUT.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // The offset depends on the instant we are looking for, so settle it in two passes.
  const first = wall - offsetMs(wall, timeZone);
  const instant = wall - offsetMs(first, timeZone);
  return new Date(instant).toISOString();
}

/** The `datetime-local` value showing `iso` as wall-clock time in `timeZone`; '' for no date. */
export function isoToLocalInput(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const p = partsIn(new Date(iso), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

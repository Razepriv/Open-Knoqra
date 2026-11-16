/** A calendar day as `YYYY-MM-DD`, always read in a user's own time zone. */
export type DayKey = string;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function toUtcMs(day: DayKey): number {
  const match = DAY_KEY_PATTERN.exec(day);
  if (!match) throw new RangeError(`Invalid day key: ${day}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** The calendar day `at` falls on in `timeZone`. */
export function dayKeyIn(at: Date, timeZone: string): DayKey {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Day arithmetic on the calendar string itself, so DST never shifts it. */
export function addDays(day: DayKey, n: number): DayKey {
  return new Date(toUtcMs(day) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(day: DayKey): number {
  return (new Date(toUtcMs(day)).getUTCDay() + 6) % 7;
}

export function isWorkingDay(day: DayKey): boolean {
  return weekdayIndex(day) < 5;
}

/** The Monday of the week containing `day`. */
export function startOfWeek(day: DayKey): DayKey {
  return addDays(day, -weekdayIndex(day));
}

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isDayKey(value: string): boolean {
  if (!DAY_KEY_PATTERN.test(value)) return false;
  return new Date(toUtcMs(value)).toISOString().slice(0, 10) === value;
}

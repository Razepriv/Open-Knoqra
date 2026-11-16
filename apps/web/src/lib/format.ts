// One place for dates and times, so every screen follows the reader's locale. `locale` is for tests:
// leave it undefined in the app and the browser's own setting is used.

type DateInput = Date | string;

const toDate = (value: DateInput): Date => (typeof value === 'string' ? new Date(value) : value);

/** A calendar date, such as "4 Nov 2026" or "Nov 4, 2026" depending on the locale. */
export function formatDate(value: DateInput, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(toDate(value));
}

/** A time of day in the reader's own zone (or `timeZone`), such as "9:41 AM" or "09:41". */
export function formatTime(value: DateInput, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(toDate(value));
}

/** The time of day somewhere else. Throws a RangeError for a zone the runtime does not know. */
export function formatTimeIn(timeZone: string, value: DateInput, locale?: string): string {
  return formatTime(value, locale, timeZone);
}

/** A day heading in capitals, such as "WED, NOV 4"; the order and punctuation follow the locale. */
export function formatDayLabel(value: DateInput, timeZone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone,
  })
    .format(toDate(value))
    .toUpperCase();
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago something happened, in the reader's language: "now", "15 minutes ago", "2 hours
 * ago", "yesterday", "3 days ago", then a plain date once it is a month old.
 */
export function relativeTime(
  value: DateInput,
  now: Date = new Date(),
  locale?: string,
  timeZone?: string,
): string {
  const then = toDate(value);
  const elapsed = Math.max(0, now.getTime() - then.getTime());
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
  if (elapsed < MINUTE_MS) return rtf.format(0, 'second');
  if (elapsed < HOUR_MS) return rtf.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
  if (elapsed < DAY_MS) return rtf.format(-Math.floor(elapsed / HOUR_MS), 'hour');
  if (elapsed < 30 * DAY_MS) return rtf.format(-Math.floor(elapsed / DAY_MS), 'day');
  return formatDate(then, locale, timeZone);
}

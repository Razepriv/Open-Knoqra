import { describe, expect, it } from 'vitest';
import { formatDate, formatDayLabel, formatTime, formatTimeIn, relativeTime } from './format';

const at = new Date('2026-11-04T15:41:00Z');

describe('date formatting follows the reader’s locale', () => {
  it('formats a calendar date', () => {
    expect(formatDate(at, 'en-GB', 'UTC')).toBe('4 Nov 2026');
    expect(formatDate(at, 'en-US', 'UTC')).toBe('Nov 4, 2026');
  });

  it('accepts an ISO string', () => {
    expect(formatDate('2026-11-04T15:41:00Z', 'en-GB', 'UTC')).toBe('4 Nov 2026');
  });

  it('formats a time of day', () => {
    expect(formatTime(at, 'en-US', 'UTC')).toMatch(/3:41\s?PM/);
    expect(formatTime(at, 'de-DE', 'UTC')).toBe('15:41');
  });

  it('formats the time in a named zone', () => {
    expect(formatTimeIn('America/Chicago', at, 'en-US')).toMatch(/9:41\s?AM/);
  });

  it('labels a day in capitals', () => {
    expect(formatDayLabel(at, 'UTC', 'en-US')).toBe('WED, NOV 4');
  });

  it('uses the runtime default when no locale is given', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(at);
    expect(formatDate(at, undefined, 'UTC')).toBe(expected);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  it.each([
    ['2026-11-12T11:59:40Z', 'now'],
    ['2026-11-12T11:45:00Z', '15 minutes ago'],
    ['2026-11-12T11:00:00Z', '1 hour ago'],
    ['2026-11-12T10:00:00Z', '2 hours ago'],
    ['2026-11-11T11:00:00Z', 'yesterday'],
    ['2026-11-09T12:00:00Z', '3 days ago'],
  ])('%s -> %s', (iso, expected) => {
    expect(relativeTime(iso, now, 'en')).toBe(expected);
  });

  it('accepts a Date and never reads the future as negative time', () => {
    expect(relativeTime(new Date('2026-11-12T12:05:00Z'), now, 'en')).toBe('now');
  });

  it('falls back to a date after a month', () => {
    expect(relativeTime('2026-08-04T12:00:00Z', now, 'en-GB')).toBe('4 Aug 2026');
  });

  it('follows the reader locale', () => {
    expect(relativeTime('2026-11-12T10:00:00Z', now, 'de')).toBe('vor 2 Stunden');
  });
});

import { describe, expect, it } from 'vitest';
import {
  chipText,
  countLabel,
  dateLine,
  dayHeader,
  heatCellLabel,
  heatmapMonths,
  hourIn,
  streakLine,
  weekRangeLabel,
} from './today-format';

describe('today formatting', () => {
  it('writes the date line with weekday, day and month', () => {
    expect(dateLine('2026-11-12')).toBe('Thursday, 12 November');
    expect(dateLine('2027-01-01')).toBe('Friday, 1 January');
  });

  it('writes a week range, naming the month once when it does not change', () => {
    expect(weekRangeLabel('2026-11-09')).toBe('9 – 15 November');
    expect(weekRangeLabel('2026-10-26')).toBe('26 October – 1 November');
    expect(weekRangeLabel('2026-12-28')).toBe('28 December 2026 – 3 January 2027');
  });

  it('writes day headers', () => {
    expect(dayHeader('2026-11-09')).toEqual({ weekday: 'Mon', date: 9 });
    expect(dayHeader('2026-11-15')).toEqual({ weekday: 'Sun', date: 15 });
  });

  it('writes the streak line for a kept, an open and a weekend today', () => {
    const streak = (todayKept: boolean) => ({ todayKept, best: 9 });
    expect(streakLine('2026-11-12', streak(true))).toBe(
      'Kept today. Next goal: beat your best run of 9.',
    );
    expect(streakLine('2026-11-12', streak(false))).toBe(
      'Today is open. One logged outcome keeps it going.',
    );
    expect(streakLine('2026-11-14', streak(false))).toBe(
      'Weekend. Your streak picks up on Monday.',
    );
    expect(streakLine('2026-11-15', streak(false))).toBe(
      'Weekend. Your streak picks up on Monday.',
    );
  });

  it('counts with the right plural', () => {
    expect(countLabel(0, 'outcome')).toBe('0 outcomes');
    expect(countLabel(1, 'outcome')).toBe('1 outcome');
    expect(countLabel(2, 'task')).toBe('2 tasks');
  });

  it('labels heatmap cells for past, today and upcoming days', () => {
    expect(heatCellLabel({ day: '2026-11-11', count: 2, state: 'past' })).toBe(
      '11 Nov · 2 outcomes',
    );
    expect(heatCellLabel({ day: '2026-11-10', count: 0, state: 'past' })).toBe(
      '10 Nov · no outcomes',
    );
    expect(heatCellLabel({ day: '2026-11-12', count: 0, state: 'today' })).toBe('Today · pending');
    expect(heatCellLabel({ day: '2026-11-12', count: 1, state: 'today' })).toBe(
      'Today · kept · 1 outcome',
    );
    expect(heatCellLabel({ day: '2026-11-14', count: 0, state: 'today' })).toBe('Today · weekend');
    expect(heatCellLabel({ day: '2026-11-14', count: 3, state: 'today' })).toBe(
      'Today · 3 outcomes',
    );
    expect(heatCellLabel({ day: '2026-11-13', count: 0, state: 'upcoming' })).toBe(
      '13 Nov · upcoming',
    );
  });

  it('places month labels where a column starts a new month, skipping one-column slivers', () => {
    const mondays = [
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
    ];
    const weeks = mondays.map((day) => ({ days: [{ day }] }));
    expect(heatmapMonths(weeks)).toEqual([
      { label: 'AUG', start: 1, span: 5 },
      { label: 'SEP', start: 6, span: 2 },
    ]);
  });

  it('writes short chip words, with the due time in the user zone', () => {
    expect(chipText({ kind: 'note', at: '2026-11-12T10:00:00Z' }, 'UTC')).toBe('Note');
    expect(chipText({ kind: 'task_done', at: '2026-11-12T10:00:00Z' }, 'UTC')).toBe('Done');
    expect(chipText({ kind: 'task_due', at: '2026-11-12T23:30:00Z' }, 'UTC')).toBe('23:30');
    expect(chipText({ kind: 'task_due', at: '2026-11-12T23:30:00Z' }, 'Asia/Kolkata')).toBe(
      '05:00',
    );
  });

  it('reads the hour in the given zone, not the machine one', () => {
    const at = new Date('2026-11-12T23:30:00Z');
    expect(hourIn(at, 'UTC')).toBe(23);
    expect(hourIn(at, 'Asia/Kolkata')).toBe(5);
    expect(hourIn(at, 'America/Los_Angeles')).toBe(15);
    expect(hourIn(new Date('2026-11-12T00:10:00Z'), 'UTC')).toBe(0);
  });
});

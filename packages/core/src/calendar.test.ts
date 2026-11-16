import { describe, expect, it } from 'vitest';
import { addDays, dayKeyIn, isDayKey, isWorkingDay, startOfWeek, weekdayIndex } from './calendar';

describe('dayKeyIn', () => {
  it('reads the day in the given zone', () => {
    expect(dayKeyIn(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(dayKeyIn(new Date('2026-11-12T03:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-12');
    expect(dayKeyIn(new Date('2026-11-12T03:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-11');
  });
});

describe('day arithmetic', () => {
  it('adds days across month ends and back', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('numbers weekdays from Monday', () => {
    expect(weekdayIndex('2026-11-09')).toBe(0);
    expect(weekdayIndex('2026-11-12')).toBe(3);
    expect(weekdayIndex('2026-11-15')).toBe(6);
  });

  it('finds working days and the Monday of a week', () => {
    expect(isWorkingDay('2026-11-13')).toBe(true);
    expect(isWorkingDay('2026-11-14')).toBe(false);
    expect(isWorkingDay('2026-11-15')).toBe(false);
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09');
    expect(startOfWeek('2026-11-09')).toBe('2026-11-09');
  });
});

describe('isDayKey', () => {
  it.each(['2026-11-12', '2028-02-29'])('accepts %s', (v) => expect(isDayKey(v)).toBe(true));
  it.each(['2026-02-30', '2026-13-01', '2026-1-1', 'nope', ''])('rejects %j', (v) =>
    expect(isDayKey(v)).toBe(false),
  );
});

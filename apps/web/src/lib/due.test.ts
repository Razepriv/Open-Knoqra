import { describe, expect, it } from 'vitest';
import { dueGroup, dueLabel, isoToLocalInput, localInputToIso } from './due';

const NY = 'America/New_York';
const at = (iso: string) => new Date(iso);
const due = (dueAt: string | null) => ({ dueAt });

describe('dueGroup and dueLabel', () => {
  const now = at('2026-11-12T15:00:00Z'); // 10:00 in New York

  it('puts a task without a date in "none"', () => {
    expect(dueGroup(due(null), now, NY)).toBe('none');
    expect(dueLabel(due(null), now, NY)).toBe('No date');
  });

  it('labels later today with the 24-hour time', () => {
    const task = due('2026-11-12T20:00:00Z');
    expect(dueGroup(task, now, NY)).toBe('today');
    expect(dueLabel(task, now, NY)).toBe('Today 15:00');
  });

  it('labels tomorrow with its time', () => {
    const task = due('2026-11-13T14:00:00Z');
    expect(dueGroup(task, now, NY)).toBe('upcoming');
    expect(dueLabel(task, now, NY)).toBe('Tomorrow 09:00');
  });

  it('labels a later day with weekday, day and month', () => {
    const task = due('2026-11-13T18:00:00Z');
    expect(dueGroup(task, at('2026-11-10T15:00:00Z'), NY)).toBe('upcoming');
    expect(dueLabel(task, at('2026-11-10T15:00:00Z'), NY)).toBe('Fri 13 Nov');
  });

  it('counts overdue in calendar days', () => {
    const two = due('2026-11-10T15:00:00Z');
    expect(dueGroup(two, now, NY)).toBe('overdue');
    expect(dueLabel(two, now, NY)).toBe('Overdue · 2 days');
    expect(dueLabel(due('2026-11-11T15:00:00Z'), now, NY)).toBe('Overdue · 1 day');
  });

  it('says "today" with the time when it went overdue earlier today', () => {
    const task = due('2026-11-12T14:00:00Z'); // 09:00 New York
    expect(dueGroup(task, now, NY)).toBe('overdue');
    expect(dueLabel(task, now, NY)).toBe('Overdue · today 09:00');
  });

  it('follows the local day around midnight, not UTC', () => {
    const lateNight = at('2026-11-13T04:30:00Z'); // 23:30 on the 12th in New York
    const justAfter = due('2026-11-13T05:30:00Z'); // 00:30 on the 13th
    expect(dueGroup(justAfter, lateNight, NY)).toBe('upcoming');
    expect(dueLabel(justAfter, lateNight, NY)).toBe('Tomorrow 00:30');
    const after = at('2026-11-13T05:30:00Z');
    const justBefore = due('2026-11-13T04:59:00Z'); // 23:59 on the 12th
    expect(dueLabel(justBefore, after, NY)).toBe('Overdue · 1 day');
  });

  it('keeps calendar days right across the autumn clock change', () => {
    const before = at('2026-11-01T12:00:00Z'); // 07:00 EST, after the clocks went back
    expect(dueLabel(due('2026-11-02T05:00:00Z'), before, NY)).toBe('Tomorrow 00:00');
    expect(dueGroup(due('2026-11-01T20:00:00Z'), before, NY)).toBe('today');
  });

  it('keeps calendar days right across the spring clock change', () => {
    const early = at('2026-03-08T06:00:00Z'); // 01:00 EST, one hour before the jump
    expect(dueLabel(due('2026-03-09T04:00:00Z'), early, NY)).toBe('Tomorrow 00:00');
    const later = at('2026-03-10T12:00:00Z');
    expect(dueLabel(due('2026-03-08T12:00:00Z'), later, NY)).toBe('Overdue · 2 days');
  });
});

describe('localInputToIso and isoToLocalInput', () => {
  it('reads a datetime-local value in the given zone', () => {
    expect(localInputToIso('2026-11-12T15:00', NY)).toBe('2026-11-12T20:00:00.000Z');
    expect(localInputToIso('2026-07-01T09:00', NY)).toBe('2026-07-01T13:00:00.000Z');
    expect(localInputToIso('2026-11-12T15:00', 'UTC')).toBe('2026-11-12T15:00:00.000Z');
    expect(localInputToIso('2026-11-12T09:30', 'Asia/Kolkata')).toBe('2026-11-12T04:00:00.000Z');
  });

  it('uses the offset that applies on the day across a clock change', () => {
    expect(localInputToIso('2026-03-08T01:30', NY)).toBe('2026-03-08T06:30:00.000Z');
    expect(localInputToIso('2026-03-08T03:30', NY)).toBe('2026-03-08T07:30:00.000Z');
  });

  it('returns null for an empty or malformed value', () => {
    expect(localInputToIso('', NY)).toBeNull();
    expect(localInputToIso('nope', NY)).toBeNull();
  });

  it('round-trips through the zone', () => {
    const iso = '2026-11-12T20:00:00.000Z';
    expect(isoToLocalInput(iso, NY)).toBe('2026-11-12T15:00');
    expect(localInputToIso(isoToLocalInput(iso, NY), NY)).toBe(iso);
    expect(isoToLocalInput(null, NY)).toBe('');
  });
});

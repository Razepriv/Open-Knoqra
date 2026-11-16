import { describe, expect, it } from 'vitest';
import { buildHeatmap, computeStreak, heatLevel } from './streak';

const counts = (...days: string[]) => new Map(days.map((d) => [d, 1]));
const TODAY = '2026-11-12'; // Thursday
const EARLIEST = '2026-01-01';

describe('computeStreak', () => {
  it('counts back from the previous working day when today is empty', () => {
    const r = computeStreak(counts('2026-11-09', '2026-11-10', '2026-11-11'), TODAY, EARLIEST);
    expect(r).toMatchObject({ current: 3, todayKept: false });
  });

  it('includes today when kept', () => {
    const r = computeStreak(
      counts('2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'),
      TODAY,
      EARLIEST,
    );
    expect(r).toMatchObject({ current: 4, todayKept: true });
  });

  it('steps over an empty weekend', () => {
    const r = computeStreak(
      counts('2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11'),
      TODAY,
      EARLIEST,
    );
    expect(r.current).toBe(4);
  });

  it('does not count weekend activity', () => {
    // Saturday activity before a Monday: the Friday gap ends the run at Monday alone.
    expect(computeStreak(counts('2026-11-07', '2026-11-09'), '2026-11-09', EARLIEST).current).toBe(
      1,
    );
  });

  it('tracks the best run separately from the current one', () => {
    const october = ['05', '06', '07', '08', '09', '12', '13'].map((d) => `2026-10-${d}`);
    const r = computeStreak(counts(...october, '2026-11-11', '2026-11-12'), TODAY, EARLIEST);
    expect(r).toMatchObject({ best: 7, current: 2 });
  });

  it('on a weekend starts from the last working day', () => {
    const week = ['09', '10', '11', '12', '13'].map((d) => `2026-11-${d}`);
    const r = computeStreak(counts(...week), '2026-11-14', EARLIEST);
    expect(r).toMatchObject({ current: 5, todayKept: false });
  });

  it('handles no activity and an earliest on a weekend', () => {
    expect(computeStreak(new Map(), TODAY, '2026-11-07')).toEqual({
      current: 0,
      best: 0,
      todayKept: false,
    });
  });
});

describe('heatLevel', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [40, 4],
  ] as const)('%i -> %i', (count, level) => expect(heatLevel(count)).toBe(level));
});

describe('buildHeatmap', () => {
  const weeks = buildHeatmap(new Map([[TODAY, 2]]), TODAY);

  it('builds 16 Monday-start columns of 7 days', () => {
    expect(weeks).toHaveLength(16);
    for (const w of weeks) expect(w.days).toHaveLength(7);
    expect(weeks[15]?.days[0]?.day).toBe('2026-11-09');
  });

  it('marks today and upcoming days', () => {
    const last = weeks[15]?.days ?? [];
    expect(last[3]).toEqual({ day: TODAY, count: 2, level: 2, state: 'today' });
    expect(last.slice(4).every((d) => d.state === 'upcoming')).toBe(true);
    expect(last[2]?.state).toBe('past');
    expect(last[2]?.count).toBe(0);
  });

  it('honours a custom week count', () => {
    expect(buildHeatmap(new Map(), TODAY, 4)).toHaveLength(4);
  });
});

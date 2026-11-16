import { describe, expect, it } from 'vitest';
import {
  DAILY_GOAL_DEFAULT,
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  normalizeWidgetOrder,
  TODAY_WIDGET_LABELS,
  TODAY_WIDGETS,
} from './today';

describe('normalizeWidgetOrder', () => {
  it('drops unknowns and repeats and appends the missing widgets', () => {
    expect(normalizeWidgetOrder(['otto', 'bogus', 'otto', 'next'])).toEqual([
      'otto',
      'next',
      'streak',
      'focus',
    ]);
  });

  it('does not mutate its input', () => {
    const input = Object.freeze(['otto', 'bogus']);
    normalizeWidgetOrder(input);
    expect(input).toEqual(['otto', 'bogus']);
  });

  it('returns the default order for empty input', () => {
    expect(normalizeWidgetOrder([])).toEqual([...TODAY_WIDGETS]);
  });
});

describe('constants', () => {
  it('labels every widget and bounds the goal', () => {
    for (const w of TODAY_WIDGETS) expect(TODAY_WIDGET_LABELS[w]).toBeTruthy();
    expect(DAILY_GOAL_DEFAULT).toBeGreaterThanOrEqual(DAILY_GOAL_MIN);
    expect(DAILY_GOAL_DEFAULT).toBeLessThanOrEqual(DAILY_GOAL_MAX);
  });
});

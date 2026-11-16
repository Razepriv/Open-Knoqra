import { describe, expect, it } from 'vitest';
import { shouldFocusStepHeading } from './setup-focus';

describe('shouldFocusStepHeading', () => {
  it('skips the first render', () => {
    expect(shouldFocusStepHeading(null, 'connect')).toBe(false);
  });
  it('skips re-renders on the same step', () => {
    expect(shouldFocusStepHeading('number', 'number')).toBe(false);
  });
  it('focuses when the step changes', () => {
    expect(shouldFocusStepHeading('connect', 'number')).toBe(true);
    expect(shouldFocusStepHeading('audio', 'number')).toBe(true);
  });
});

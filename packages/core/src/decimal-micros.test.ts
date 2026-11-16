import { describe, expect, it } from 'vitest';
import { formatMicrosDecimal, parseDecimalMicros } from './decimal-micros';

describe('parseDecimalMicros', () => {
  it.each([
    ['300.00', 300_000_000],
    ['-1.5', -1_500_000],
    ['0.000001', 1],
    ['5', 5_000_000],
    ['1.0000001', null],
    ['abc', null],
    ['', null],
    ['1.', null],
    ['.5', null],
    ['1e3', null],
  ])('parses %j', (input, expected) => {
    expect(parseDecimalMicros(input)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(parseDecimalMicros('-0'), 0)).toBe(true);
  });
});

describe('formatMicrosDecimal', () => {
  it.each([
    [-20_000, '-0.020000'],
    [5_000_000, '5.000000'],
    [0, '0.000000'],
    [1, '0.000001'],
  ])('formats %d', (micros, expected) => {
    expect(formatMicrosDecimal(micros)).toBe(expected);
  });
});

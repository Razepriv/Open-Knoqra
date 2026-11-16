import { describe, expect, it } from 'vitest';
import { dollarsToMicros, formatMicros } from './money';

describe('formatMicros', () => {
  it.each([
    [0, '$0.00'],
    [100_000, '$0.10'],
    [4_980_000, '$4.98'],
    [10_000, '$0.01'],
    [1_000_000, '$1.00'],
    [123_456_000_000, '$123456.00'],
    [5_000, '$0.005'],
    [15_000, '$0.015'],
    [4_985_000, '$4.985'],
    [5, '$0.000005'],
    [1_230_000, '$1.23'],
    [-20_000, '-$0.02'],
    [-5_000, '-$0.005'],
    [-4_980_000, '-$4.98'],
  ])('formats %d micros as %s', (micros, text) => {
    expect(formatMicros(micros)).toBe(text);
  });

  it('never shows negative zero', () => {
    expect(formatMicros(-0)).toBe('$0.00');
  });
});

describe('dollarsToMicros', () => {
  it.each([
    ['0.1', 100_000],
    ['0.10', 100_000],
    ['5', 5_000_000],
    ['$5', 5_000_000],
    ['$ 5.25', null],
    ['12.345678', 12_345_678],
    ['1.', 1_000_000],
    ['.5', 500_000],
    ['0', 0],
    ['  7.5  ', 7_500_000],
    ['1.0000001', null],
    ['abc', null],
    ['', null],
    ['$', null],
    ['.', null],
    ['-1', null],
    ['-$1', null],
    ['$-1', null],
    ['1e3', null],
    ['1,000', null],
    ['1.2.3', null],
    ['9999999999', null],
  ])('parses %j as %s', (input, micros) => {
    expect(dollarsToMicros(input)).toBe(micros);
  });

  it('is exact where float math is not', () => {
    // 4.35 * 100 and 0.1 + 0.2 both drift in floating point.
    expect(dollarsToMicros('4.35')).toBe(4_350_000);
    expect(dollarsToMicros('0.3')).toBe(300_000);
    expect(dollarsToMicros('1.005')).toBe(1_005_000);
  });
});

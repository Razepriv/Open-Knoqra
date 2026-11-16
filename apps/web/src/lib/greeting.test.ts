import { describe, expect, it } from 'vitest';
import { firstName, greeting, partOfDay } from './greeting';

describe('greeting', () => {
  it.each([
    [0, 'evening'],
    [4, 'evening'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [17, 'afternoon'],
    [18, 'evening'],
    [23, 'evening'],
  ] as const)('hour %i is %s', (hour, expected) => {
    expect(partOfDay(hour)).toBe(expected);
  });

  it('uses the first name only', () => {
    expect(firstName('  Ana   Silva ')).toBe('Ana');
    expect(greeting('Ana Silva', 9)).toBe('Good morning, Ana');
  });

  it('drops the comma when there is no name', () => {
    expect(greeting('   ', 14)).toBe('Good afternoon');
  });
});

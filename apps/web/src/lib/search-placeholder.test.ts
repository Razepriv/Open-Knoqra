import { describe, expect, it } from 'vitest';
import { searchPlaceholder } from './contacts';

describe('searchPlaceholder', () => {
  it('counts the people once the whole list is known', () => {
    expect(searchPlaceholder(5)).toBe('Search 5 people');
    expect(searchPlaceholder(1)).toBe('Search 1 person');
  });

  it('falls back to plain words when the count is unknown or zero', () => {
    expect(searchPlaceholder(null)).toBe('Search contacts');
    expect(searchPlaceholder(0)).toBe('Search contacts');
  });
});

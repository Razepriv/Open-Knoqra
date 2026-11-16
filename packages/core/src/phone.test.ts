import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone';

const INVALID = { ok: false, error: 'invalid_phone' };

describe('normalizePhone', () => {
  it.each([
    ['(202) 555-0123', '+12025550123'],
    ['+1 202 555 0123', '+12025550123'],
    ['  (202) 555-0123  ', '+12025550123'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['', '   ', '12', 'call me', '+1 000', '1'.repeat(300)])('rejects %j', (input) => {
    expect(normalizePhone(input)).toEqual(INVALID);
  });

  it.each([null, undefined, 12025550123, {}])('rejects non-string %j without throwing', (input) => {
    expect(() => normalizePhone(input as never)).not.toThrow();
    expect(normalizePhone(input as never)).toEqual(INVALID);
  });
});

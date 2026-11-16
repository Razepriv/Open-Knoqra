import { describe, expect, it } from 'vitest';
import { EMERGENCY_CALL_MESSAGE, isEmergencyNumber } from './emergency';

describe('isEmergencyNumber', () => {
  it.each([
    '911',
    ' 9 1 1 ',
    '+1 911',
    '1-911',
    '(911)',
    '933',
    '988',
    '112',
    '+91 112',
    '999',
    '000',
    '100',
    '101',
    '102',
    '108',
    '211',
    '311',
    '411',
    '511',
    '611',
    '711',
    '811',
  ])('blocks %j', (input) => {
    expect(isEmergencyNumber(input)).toBe(true);
  });

  it.each([
    '+1 202 555 0123',
    '(202) 555-0911',
    '+12025550911',
    '9110',
    '+44 20 7946 0958',
    '011',
    '',
    'call me',
    '1'.repeat(300),
  ])('allows %j', (input) => {
    expect(isEmergencyNumber(input)).toBe(false);
  });

  it.each([null, undefined, 911, {}])(
    'treats non-string %j as not an emergency number',
    (input) => {
      expect(() => isEmergencyNumber(input as never)).not.toThrow();
      expect(isEmergencyNumber(input as never)).toBe(false);
    },
  );

  it('explains where to call instead', () => {
    expect(EMERGENCY_CALL_MESSAGE).toContain('112');
    expect(EMERGENCY_CALL_MESSAGE).toContain('911');
  });
});

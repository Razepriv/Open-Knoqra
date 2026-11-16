import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, isValidTimeZone } from './timezone';

describe('isValidTimeZone', () => {
  it.each(['America/New_York', 'Europe/London', 'UTC', 'Asia/Kolkata'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['', 'Mars/Base', 'not a zone', '+05:00', 'America/'])('rejects %j', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe('canonicalTimeZone', () => {
  it.each([
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['Pacific/Enderbury', 'Pacific/Kanton'],
  ])('maps the legacy alias %s to %s', (legacy, current) => {
    expect(canonicalTimeZone(legacy)).toBe(current);
    expect(isValidTimeZone(current)).toBe(true);
  });

  it.each(['Asia/Kolkata', 'UTC', 'America/New_York', 'Mars/Base'])(
    'leaves %s as it is',
    (zone) => {
      expect(canonicalTimeZone(zone)).toBe(zone);
    },
  );

  it('does not treat inherited object keys as aliases', () => {
    expect(canonicalTimeZone('constructor')).toBe('constructor');
    expect(canonicalTimeZone('__proto__')).toBe('__proto__');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ANALYZE_SQL,
  canReset,
  describeReset,
  EMPTINESS_SQL,
  isPopulated,
  parseCounts,
  RESET_TRUNCATE_SQL,
} from '../src/seed/reset';

describe('seed reset helpers', () => {
  it('truncates audit_event, which no foreign key reaches', () => {
    expect(RESET_TRUNCATE_SQL).toBe(
      'TRUNCATE "user", organization, audit_event, usage_event CASCADE',
    );
    expect(EMPTINESS_SQL).toContain('audit_event');
    expect(ANALYZE_SQL).toContain('audit_event');
  });

  it('only resets databases whose name contains perf', () => {
    expect(canReset('knoqra_s9_perf')).toBe(true);
    expect(canReset('knoqra_s9_perf_scratch')).toBe(true);
    expect(canReset('knoqra_s9')).toBe(false);
    expect(canReset('knoqra')).toBe(false);
    expect(canReset('knoqra_m1')).toBe(false);
  });

  it('treats any non-empty table as populated', () => {
    const empty = parseCounts({ contacts: '0', users: '0', organizations: '0', audit_events: '0' });
    expect(isPopulated(empty)).toBe(false);
    expect(isPopulated({ ...empty, auditEvents: 3 })).toBe(true);
    expect(isPopulated({ ...empty, users: 1 })).toBe(true);
    expect(parseCounts(undefined)).toEqual(empty);
  });

  it('names the database and the counts being removed', () => {
    const line = describeReset('x_perf', {
      contacts: 5,
      users: 2,
      organizations: 2,
      auditEvents: 7,
    });
    expect(line).toContain('x_perf');
    expect(line).toContain('2 users');
    expect(line).toContain('5 contacts');
    expect(line).toContain('7 audit events');
  });
});

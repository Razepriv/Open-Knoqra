import { describe, expect, it } from 'vitest';
import { analyzePlan } from '../src/explain/analyze';
import { isControlStatement } from '../src/explain/replay';

const LARGE = new Set(['contact', 'timeline_event']);

const seqOnContact = {
  'Execution Time': 12.5,
  'Planning Time': 0.4,
  Plan: {
    'Node Type': 'Limit',
    Plans: [
      {
        'Node Type': 'Gather',
        Plans: [{ 'Node Type': 'Seq Scan', 'Parallel Aware': true, 'Relation Name': 'contact' }],
      },
    ],
  },
};

describe('analyzePlan', () => {
  it('flags a nested seq scan on a large table', () => {
    const r = analyzePlan(seqOnContact, LARGE, undefined);
    expect(r.violations).toEqual(['seq scan on contact']);
    expect(r.seqScans).toEqual(['contact']);
  });

  it('allows a seq scan the case permits', () => {
    const r = analyzePlan(seqOnContact, LARGE, [{ table: 'contact', reason: 'R2' }]);
    expect(r.violations).toEqual([]);
    expect(r.seqScans).toEqual(['contact']);
  });

  it('ignores seq scans on small tables', () => {
    const plan = {
      'Execution Time': 1,
      'Planning Time': 0.1,
      Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'member' },
    };
    expect(analyzePlan(plan, LARGE, undefined).violations).toEqual([]);
  });

  it('lists index scans in nodes and reports times', () => {
    const plan = {
      'Execution Time': 0.3,
      'Planning Time': 0.2,
      Plan: {
        'Node Type': 'Index Scan',
        'Index Name': 'contact_active_sort_idx',
        'Relation Name': 'contact',
      },
    };
    const r = analyzePlan(plan, LARGE, undefined);
    expect(r.violations).toEqual([]);
    expect(r.nodes).toContain('Index Scan using contact_active_sort_idx');
    expect(r.executionMs).toBe(0.3);
    expect(r.planningMs).toBe(0.2);
  });
});

describe('isControlStatement', () => {
  it('recognises transaction control', () => {
    expect(isControlStatement(' begin')).toBe(true);
    expect(isControlStatement('SAVEPOINT x')).toBe(true);
    expect(isControlStatement('commit')).toBe(true);
    expect(isControlStatement('select 1')).toBe(false);
  });
});

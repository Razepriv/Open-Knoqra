import { describe, expect, it } from 'vitest';
import { PHASE1_CASES } from '../src/explain/phase1-cases';
import { EXPLAIN_CASES, resolveCase } from '../src/explain/registry';
import { buildFixtures, planSeed } from '../src/seed/fixtures';
import { SAMPLE_PHASE1_RAW } from './phase1-raw';

const fixtures = buildFixtures(planSeed(42, 0.01), {
  database: 'x_perf',
  contactsDeep: { name: 'a', id: 'ct_a' },
  timelineDeep: { occurredAt: '2026-01-02T03:04:05.123456Z', id: 'te_a' },
  phase1: SAMPLE_PHASE1_RAW,
});

describe('Phase 1 explain cases', () => {
  it('resolves every registry placeholder against the fixtures', () => {
    for (const c of EXPLAIN_CASES) expect(() => resolveCase(c, fixtures)).not.toThrow();
    expect(new Set(EXPLAIN_CASES.map((c) => c.name)).size).toBe(EXPLAIN_CASES.length);
  });

  it('covers every Phase 1 milestone with GET cases inside the budgets', () => {
    const milestones = new Set(PHASE1_CASES.map((c) => c.milestone));
    for (const m of ['M2', 'M3', 'M3b', 'M4', 'M4b', 'M5']) expect(milestones.has(m)).toBe(true);
    for (const c of PHASE1_CASES) {
      expect(c.method).toBe('GET');
      expect([20, 50, 100, 150]).toContain(c.budgetMs);
    }
  });

  it('allows time over budget only for the usage ledger, under ruling T10-b', () => {
    const allowed = EXPLAIN_CASES.filter((c) => c.allowOverBudget !== undefined);
    expect(allowed.map((c) => c.name)).toEqual([
      'usage.ledger.first',
      'usage.ledger.deep',
      'usage.ledger.filtered',
    ]);
    for (const c of allowed) {
      expect(c.allowOverBudget?.reason).toMatch(/^T10-b: /);
      expect(c.allowOverBudget?.ceilingMs).toBe(3000);
    }
  });

  it('allowlists a sequential scan only on contact, for R2 substring search', () => {
    for (const c of PHASE1_CASES) {
      for (const allowed of c.allowSeqScan ?? []) {
        expect(c.name.startsWith('conversations.search.')).toBe(true);
        expect(allowed.table).toBe('contact');
        expect(allowed.reason).toMatch(/^R2/);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import { collectIds } from '../src/explain/analyze';
import { fillBody } from '../src/explain/registry';
import { isTolerableConflict } from '../src/explain/replay';
import {
  type CaseResult,
  caseProblems,
  isAllowedOverBudget,
  renderReport,
} from '../src/explain/report';
import type { Fixtures } from '../src/seed/fixtures';
import { deepOffset } from '../src/seed/fixtures';

const stmt = (executionMs: number, violations: string[] = []) => ({
  sql: 'select 1',
  buffers: 'hit=0 read=0',
  executionMs,
  planningMs: 0,
  seqScans: [],
  violations,
  nodes: [],
});

describe('isTolerableConflict', () => {
  it('tolerates a unique violation on a mutating insert only', () => {
    expect(isTolerableConflict('insert into t values ($1)', '23505', true)).toBe(true);
    expect(isTolerableConflict('insert into t values ($1)', '23505', false)).toBe(false);
    expect(isTolerableConflict('insert into t values ($1)', '23503', true)).toBe(false);
    expect(isTolerableConflict('with x as (select 1) select * from x', '23505', true)).toBe(false);
    expect(isTolerableConflict('select 1', '23505', true)).toBe(false);
  });
});

describe('fillBody', () => {
  const fixtures = {
    ids: { heavy: 'ct_a' },
    importRows: [{ displayName: 'A' }],
  } as unknown as Fixtures;
  it('resolves $fixture references raw and templates strings', () => {
    expect(fillBody({ rows: { $fixture: 'importRows' }, id: '{ids.heavy}' }, fixtures)).toEqual({
      rows: [{ displayName: 'A' }],
      id: 'ct_a',
    });
  });
  it('throws on an unknown reference', () => {
    expect(() => fillBody({ $fixture: 'nope.x' }, fixtures)).toThrow(
      'unknown placeholder {nope.x}',
    );
  });
});

describe('caseProblems', () => {
  const base = { name: 'c', milestone: 'M1', budgetMs: 50, httpStatus: 200 };
  it('passes a fast 2xx case', () => {
    expect(caseProblems({ ...base, statements: [stmt(10)] }, [])).toEqual([]);
  });
  it('sums statement time against the budget', () => {
    const p = caseProblems({ ...base, statements: [stmt(30), stmt(30)] }, []);
    expect(p).toEqual(['over budget (60.00 ms > 50 ms)']);
  });
  it('reports non-2xx, violations and extra problems', () => {
    const p = caseProblems(
      { ...base, httpStatus: 500, statements: [stmt(1, ['seq scan on contact'])] },
      ['isolation: x'],
    );
    expect(p).toEqual(['isolation: x', 'HTTP 500', 'seq scan on contact']);
  });
  it('lets a ruling allow time over budget, and nothing else', () => {
    const allowed = { ...base, overBudgetAllowed: { reason: 'T10-b', ceilingMs: 3000 } };
    expect(caseProblems({ ...allowed, statements: [stmt(500)] }, [])).toEqual([]);
    expect(
      caseProblems({ ...allowed, httpStatus: 500, statements: [stmt(500, ['seq scan on x'])] }, []),
    ).toEqual(['HTTP 500', 'seq scan on x']);
  });
  it('fails an allowlisted case above its ceiling', () => {
    const allowed = { ...base, overBudgetAllowed: { reason: 'T10-b', ceilingMs: 3000 } };
    expect(caseProblems({ ...allowed, statements: [stmt(3000)] }, [])).toEqual([]);
    expect(caseProblems({ ...allowed, statements: [stmt(2000), stmt(1500)] }, [])).toEqual([
      'over allowlisted ceiling (3500.00 ms > 3000 ms)',
    ]);
    const r = { ...allowed, statements: [stmt(3500)] };
    expect(isAllowedOverBudget(r)).toBe(false);
    expect(isAllowedOverBudget({ ...r, statements: [stmt(1500)] })).toBe(true);
    expect(isAllowedOverBudget({ ...r, statements: [stmt(10)] })).toBe(false);
  });
});

describe('renderReport allowlisted time', () => {
  it('keeps the measured time and the ruling visible', () => {
    const r: CaseResult = {
      name: 'usage.ledger.first',
      milestone: 'M4',
      budgetMs: 100,
      httpStatus: 200,
      statements: [stmt(1234.5)],
      notes: [],
      problems: [],
      overBudgetAllowed: { reason: 'T10-b: reason', ceilingMs: 3000 },
    };
    const meta = {
      date: 'd',
      database: 'db',
      platform: 'p',
      cpus: 1,
      node: 'n',
      postgres: 'pg',
      rows: 'r',
    };
    const md = renderReport([r], meta);
    expect(md).toContain('Overall: PASS');
    expect(md).toContain('| usage.ledger.first | M4 | PASS (allowlisted) | 1234.50 | 100 |');
    expect(md).toContain(
      '- Allowlisted over budget (1234.50 ms > 100 ms, ceiling 3000 ms): T10-b: reason',
    );
  });
  it('fails the run when an allowlisted case passes its ceiling', () => {
    const base = {
      name: 'usage.ledger.first',
      milestone: 'M4',
      budgetMs: 100,
      httpStatus: 200,
      statements: [stmt(3200)],
      overBudgetAllowed: { reason: 'T10-b: reason', ceilingMs: 3000 },
    };
    const r: CaseResult = { ...base, notes: [], problems: caseProblems(base, []) };
    const md = renderReport([r], {
      date: 'd',
      database: 'db',
      platform: 'p',
      cpus: 1,
      node: 'n',
      postgres: 'pg',
      rows: 'r',
    });
    expect(md).toContain('Overall: **FAIL** (1 of 1 cases)');
    expect(md).toContain('- **FAIL**: over allowlisted ceiling (3200.00 ms > 3000 ms)');
    expect(md).not.toContain('Allowlisted over budget');
  });
});

describe('renderReport', () => {
  it('states when a case was replayed only in part', () => {
    const r: CaseResult = {
      name: 'import.upsert',
      milestone: 'M1',
      budgetMs: 150,
      httpStatus: 200,
      statements: [stmt(1)],
      notes: ['duplicate key'],
      problems: [],
    };
    const meta = {
      date: 'd',
      database: 'db',
      platform: 'p',
      cpus: 1,
      node: 'n',
      postgres: 'pg',
      rows: 'r',
    };
    const md = renderReport([r], meta);
    expect(md).toContain('- Partial: import.upsert');
    expect(md).toContain('- Note: duplicate key');
  });
});

describe('collectIds', () => {
  it('collects id, contactId and organizationId strings at any depth', () => {
    const found = collectIds({
      data: { items: [{ id: 'ct_1', organizationId: 'o', other: { contactId: 'ct_2' } }] },
      id: 7,
    });
    expect(found).toEqual([
      { key: 'id', value: 'ct_1' },
      { key: 'organizationId', value: 'o' },
      { key: 'contactId', value: 'ct_2' },
    ]);
  });
});

describe('deepOffset', () => {
  it('scales and rounds the full-size offset', () => {
    expect(deepOffset(50_000, 1, 100_000)).toBe(50_000);
    expect(deepOffset(50_000, 0.01, 1_000)).toBe(500);
    expect(deepOffset(25_000, 0.0001, 100)).toBe(3);
  });
  it('clamps to the last row and never goes negative', () => {
    expect(deepOffset(50_000, 1, 30)).toBe(29);
    expect(deepOffset(50_000, 1, 0)).toBe(0);
  });
});

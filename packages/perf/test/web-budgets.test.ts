import { describe, expect, it } from 'vitest';
import {
  aggregate,
  evaluate,
  extractLayoutShifts,
  extractLcpElement,
  type LhrLike,
  median,
  PAGES,
  renderWebReport,
  WEB_BUDGETS,
} from '../src/web/budgets';

function lhr(
  overrides: { lcp?: number; cls?: number; tbt?: number; score?: number } = {},
): LhrLike {
  return {
    audits: {
      'largest-contentful-paint': { numericValue: overrides.lcp ?? 1000 },
      'cumulative-layout-shift': { numericValue: overrides.cls ?? 0 },
      'total-blocking-time': { numericValue: overrides.tbt ?? 50 },
    },
    categories: { performance: { score: overrides.score ?? 0.98 } },
  };
}

describe('WEB_BUDGETS and PAGES', () => {
  it('pins the budgets and the main screens', () => {
    expect(WEB_BUDGETS).toEqual({ lcpMs: 2000, cls: 0.05 });
    expect(PAGES.map((p) => [p.name, p.path, p.auth])).toEqual([
      ['sign-in', '/sign-in', false],
      ['contacts', '/contacts', true],
      ['contact360', '/contacts/{ids.heavy}', true],
      ['inbox', '/inbox', true],
      ['calls', '/calls', true],
      ['tasks', '/tasks', true],
    ]);
  });
});

describe('evaluate', () => {
  it('reads LCP, CLS, TBT and the performance score', () => {
    const result = evaluate(lhr({ lcp: 1500, cls: 0.01, tbt: 80, score: 0.91 }), 'contacts');
    expect(result).toEqual({
      lcpMs: 1500,
      cls: 0.01,
      tbtMs: 80,
      performanceScore: 91,
      violations: [],
    });
  });

  it('flags LCP over budget', () => {
    expect(evaluate(lhr({ lcp: 2100 }), 'contacts').violations).toEqual([
      'contacts: LCP 2.10 s is over 2.00 s',
    ]);
  });

  it('flags CLS over budget', () => {
    expect(evaluate(lhr({ cls: 0.06 }), 'contacts').violations).toEqual([
      'contacts: CLS 0.060 is over 0.050',
    ]);
  });

  it('passes exactly at budget', () => {
    expect(evaluate(lhr({ lcp: 2000, cls: 0.05 }), 'contacts').violations).toEqual([]);
  });

  it('reports a missing metric as a violation, not as zero', () => {
    const broken: LhrLike = { audits: {}, categories: {} };
    const result = evaluate(broken, 'contacts');
    expect(result.violations).toEqual([
      'contacts: no LCP value in the Lighthouse result',
      'contacts: no CLS value in the Lighthouse result',
    ]);
  });
});

describe('median and aggregate', () => {
  it('takes the middle value of an odd count and the mean of the middle two otherwise', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('rejects an empty list', () => {
    expect(() => median([])).toThrow();
  });

  it('judges the median of 3 runs, so one outlier does not fail the page', () => {
    const runs = [lhr({ lcp: 900 }), lhr({ lcp: 5000, cls: 0.4 }), lhr({ lcp: 1100, cls: 0.01 })];
    const result = aggregate('contacts', runs);
    expect(result.lcpMs).toBe(1100);
    expect(result.cls).toBe(0.01);
    expect(result.violations).toEqual([]);
    expect(result.runs).toBe(3);
  });

  it('fails when the median itself is over budget', () => {
    const runs = [lhr({ lcp: 2500 }), lhr({ lcp: 2600 }), lhr({ lcp: 900 })];
    expect(aggregate('contacts', runs).violations).toEqual(['contacts: LCP 2.50 s is over 2.00 s']);
  });

  it('keeps the run at the median LCP for the detail sections', () => {
    const slow = lhr({ lcp: 3000 });
    const mid = lhr({ lcp: 1500 });
    const fast = lhr({ lcp: 800 });
    expect(aggregate('contacts', [slow, mid, fast]).medianRun).toBe(mid);
  });
});

describe('aggregate with missing metrics', () => {
  it('ignores a run without LCP in the median and reports it', () => {
    const noLcp: LhrLike = { audits: {}, categories: {} };
    const result = aggregate('contacts', [lhr({ lcp: 1000 }), noLcp, lhr({ lcp: 1200 })]);
    expect(result.lcpMs).toBe(1100);
    expect(result.violations).toContain('contacts: run 2 had no LCP');
    expect(result.violations).toContain('contacts: run 2 had no CLS');
  });

  it('is NaN with a violation when every run lacks LCP', () => {
    const noLcp: LhrLike = { audits: {}, categories: {} };
    const result = aggregate('contacts', [noLcp, noLcp]);
    expect(Number.isNaN(result.lcpMs)).toBe(true);
    expect(result.violations).toContain('contacts: no LCP value in the Lighthouse result');
  });
});

describe('extractLcpElement', () => {
  it('reads the element and the phase breakdown', () => {
    const run: LhrLike = {
      audits: {
        'largest-contentful-paint-element': {
          details: {
            type: 'list',
            items: [
              {
                type: 'table',
                items: [
                  { node: { selector: 'main > h1', nodeLabel: 'Contacts', snippet: '<h1>' } },
                ],
              },
              {
                type: 'table',
                items: [
                  { phase: 'TTFB', timing: 120.4, percent: '10%' },
                  { phase: 'Element render delay', timing: 800, percent: '70%' },
                ],
              },
            ],
          },
        },
      },
      categories: {},
    };
    expect(extractLcpElement(run)).toEqual({
      elements: ['main > h1 (Contacts)'],
      phases: ['TTFB 120 ms', 'Element render delay 800 ms'],
    });
  });

  it('is empty when the audit is absent', () => {
    expect(extractLcpElement({ audits: {}, categories: {} })).toEqual({
      elements: [],
      phases: [],
    });
  });
});

describe('extractLayoutShifts', () => {
  const shifts: LhrLike = {
    audits: {
      'layout-shifts': {
        details: {
          type: 'table',
          items: [
            { node: { selector: 'div.a' }, score: 0.01 },
            { node: { selector: 'div.b', nodeLabel: 'Row' }, score: 0.03 },
            { node: { snippet: '<img>' }, score: 0.02 },
            { node: { selector: 'div.d' }, score: 0.005 },
          ],
        },
      },
    },
    categories: {},
  };

  it('returns the top 3 by score, largest first', () => {
    expect(extractLayoutShifts(shifts)).toEqual([
      'div.b (Row): 0.0300',
      '<img>: 0.0200',
      'div.a: 0.0100',
    ]);
  });

  it('is empty when there are no shifts', () => {
    expect(extractLayoutShifts({ audits: {}, categories: {} })).toEqual([]);
  });
});

describe('renderWebReport', () => {
  const pass = aggregate('contacts', [lhr(), lhr(), lhr()]);
  const meta = { date: '2026-11-13', database: 'knoqra_s9_perf', machine: 'win32, 8 CPUs' };
  const bundle = {
    initialBytes: 2048,
    files: ['assets/index-a.js', 'assets/vendor-b.js'],
    violations: [],
    sizes: { 'assets/index-a.js': 1024, 'assets/vendor-b.js': 1024 },
  };

  it('has the bundle table and a per-page table', () => {
    const text = renderWebReport({ ...meta, bundle, pages: [pass] });
    expect(text).toContain('Overall: PASS');
    expect(text).toContain('| assets/index-a.js | 1.0 |');
    expect(text).toContain('| Total initial JS | 2.0 |');
    expect(text).toContain('| contacts | 1.00 | 0.000 | 50 | 98 |');
    expect(text).toContain('Machine: win32, 8 CPUs');
  });

  it('marks FAIL and lists violations, including bundle ones', () => {
    const bad = aggregate('contacts', [lhr({ lcp: 3000 }), lhr({ lcp: 3000 }), lhr({ lcp: 3000 })]);
    const text = renderWebReport({
      ...meta,
      bundle: { ...bundle, violations: ['initial JS too big'] },
      pages: [bad],
    });
    expect(text).toContain('**FAIL**');
    expect(text).toContain('contacts: LCP 3.00 s is over 2.00 s');
    expect(text).toContain('initial JS too big');
  });

  it('marks an incomplete run FAIL with the failure and keeps the bundle table', () => {
    const text = renderWebReport({
      ...meta,
      bundle,
      pages: [pass],
      failures: ['contact360: Lighthouse failed: timeout'],
    });
    expect(text).toContain('**FAIL**');
    expect(text).toContain('contact360: Lighthouse failed: timeout');
    expect(text).toContain('Incomplete run');
    expect(text).toContain('| Total initial JS | 2.0 |');
  });
});

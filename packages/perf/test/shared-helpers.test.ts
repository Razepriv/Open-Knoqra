import { describe, expect, it } from 'vitest';
import { flagValue, parseFixtures } from '../src/config';
import { renderReport } from '../src/explain/report';
import { type Mix, preflightMix, verdict } from '../src/load/runner';
import { machineSummary } from '../src/machine';
import { buildFixtures, planSeed } from '../src/seed/fixtures';
import { unrepointedReferences } from '../src/seed/index';
import { isBuildStale, WEB_BUILD_INPUTS } from '../src/server';
import { SAMPLE_PHASE1_RAW } from './phase1-raw';

const fixtures = buildFixtures(planSeed(7, 0.01), {
  database: 'knoqra_perf_test',
  contactsDeep: { name: 'a', id: 'ct_a' },
  timelineDeep: { occurredAt: '2026-01-01T00:00:00.000Z', id: 'te_a' },
  phase1: SAMPLE_PHASE1_RAW,
});

describe('flagValue', () => {
  it('reads --flag value and --flag=value', () => {
    expect(flagValue(['--out', 'a.md'], '--out')).toBe('a.md');
    expect(flagValue(['--out=f'], '--out')).toBe('f');
    expect(flagValue(['--vus=5', '--x', '1'], '--vus')).toBe('5');
    expect(flagValue(['--x'], '--out')).toBeUndefined();
  });
});

describe('parseFixtures', () => {
  it('gives one line for a missing file, no path', () => {
    expect(() => parseFixtures(undefined, 'knoqra_perf_x')).toThrow(
      'no fixtures for knoqra_perf_x: run pnpm perf:seed --database knoqra_perf_x first',
    );
  });

  it('gives one message for a mismatched database', () => {
    const text = JSON.stringify(fixtures);
    expect(() => parseFixtures(text, 'knoqra_perf_other')).toThrow(
      /fixtures were seeded for knoqra_perf_test, not knoqra_perf_other: run pnpm perf:seed/,
    );
    expect(parseFixtures(text, 'knoqra_perf_test').database).toBe('knoqra_perf_test');
  });
});

describe('preflightMix', () => {
  const ok: Mix = {
    scenarios: [
      {
        name: 's',
        weight: 100,
        requests: [{ name: 'list', method: 'GET', path: '/x/{ids.first}' }],
      },
    ],
  };
  it('is null for a resolvable mix', () => {
    expect(preflightMix(ok, fixtures)).toBeNull();
  });

  it('reports the first unresolvable placeholder, including rotated ones', () => {
    const bad: Mix = {
      scenarios: [
        {
          name: 's',
          weight: 100,
          requests: [{ name: 'search', method: 'GET', path: '/x?q={rotate:ids.first|nope.key}' }],
        },
      ],
    };
    expect(preflightMix(bad, fixtures)).toMatch(/s\/search: unknown placeholder \{nope\.key\}/);
  });
});

describe('verdict', () => {
  it('fails on a request error sample', () => {
    const summary = { count: 1, errors: 1, p50: 0, p95: 0, p99: 0, max: 0, rps: 0 };
    expect(verdict({ requests: { 's/list': summary } })).toEqual(['s/list: 1 errors']);
  });
});

describe('explain failure report', () => {
  it('marks the report FAIL with the reason when the run aborted', () => {
    const text = renderReport([], {
      date: '2026-11-12',
      database: 'knoqra_perf_test',
      platform: 'linux',
      cpus: 4,
      node: '22.0.0',
      postgres: '17.0',
      rows: 'row counts unavailable',
      failure: 'run aborted: sign-in failed',
    });
    expect(text).toContain('Overall: **FAIL** (run aborted)');
    expect(text).toContain('- **FAIL**: run aborted: sign-in failed');
  });
});

describe('unrepointedReferences', () => {
  it('keeps only references the pin does not repoint', () => {
    const refs = [
      { table: 'member', column: 'organization_id' },
      { table: 'invitation', column: 'organization_id' },
      { table: 'session', column: 'active_organization_id' },
      { table: 'contact', column: 'organization_id' },
      { table: '"timeline_event"', column: 'organization_id' },
    ];
    expect(unrepointedReferences(refs).map((r) => r.table)).toEqual([
      'contact',
      '"timeline_event"',
    ]);
  });
});

describe('machineSummary', () => {
  it('appends the PostgreSQL version when given', () => {
    expect(machineSummary()).not.toMatch(/PostgreSQL/);
    expect(machineSummary('17.2')).toMatch(/, PostgreSQL 17\.2$/);
  });
});

describe('web build staleness', () => {
  it('is stale when dist is missing or any input is newer', () => {
    expect(isBuildStale(0, [1])).toBe(true);
    expect(isBuildStale(10, [5, 11])).toBe(true);
    expect(isBuildStale(10, [5, 10])).toBe(false);
  });

  it('watches the shell, config, public and shared packages', () => {
    for (const p of [
      'apps/web/index.html',
      'apps/web/vite.config.ts',
      'apps/web/public',
      'packages/ui/src',
      'packages/tokens',
      'packages/brand',
    ]) {
      expect(WEB_BUILD_INPUTS).toContain(p);
    }
  });
});

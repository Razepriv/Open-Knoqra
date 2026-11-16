import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { renderLoadReport } from '../src/load/index';
import { httpTransport, type Mix, runLoad, verdict } from '../src/load/runner';
import { percentile, summarize } from '../src/load/stats';
import { renderRealtimeReport } from '../src/realtime/index';
import type { Fixtures } from '../src/seed/fixtures';
import { killPlan } from '../src/server';

describe('percentile', () => {
  it('uses nearest-rank', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([], 95)).toBe(0);
  });
});

describe('summarize', () => {
  it('counts errors and computes the percentiles', () => {
    const samples = [
      { ms: 10, ok: true },
      { ms: 30, ok: true },
      { ms: 20, ok: false },
      { ms: 40, ok: true },
    ];
    const s = summarize(samples, 2);
    expect(s).toMatchObject({ count: 4, errors: 1, p50: 20, max: 40, rps: 2 });
  });

  it('gives zeros for an empty list, not NaN', () => {
    expect(summarize([], 10)).toEqual({
      count: 0,
      errors: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      rps: 0,
    });
  });
});

describe('verdict', () => {
  it('fails on errors and on gated p95 over budget', () => {
    const ok = { count: 5, errors: 0, p50: 1, p95: 10, p99: 10, max: 10, rps: 1 };
    expect(verdict({ requests: { 'a/list': ok } }).length).toBe(0);
    expect(verdict({ requests: { 'a/list': { ...ok, errors: 1 } } }).length).toBe(1);
    expect(verdict({ requests: { 'a/list': { ...ok, p95: 151 } } }).length).toBe(1);
    expect(verdict({ requests: { 'a/permissions': { ...ok, p95: 500 } } }).length).toBe(0);
  });
});

describe('runLoad', () => {
  it('drives a local server with 2 virtual users', async () => {
    const seen = { signIn: 0, other: 0, badOrigin: 0 };
    const server = createServer((req, res) => {
      if (req.headers.origin !== 'http://web.test') seen.badOrigin += 1;
      if (req.url === '/api/auth/sign-in/email') {
        seen.signIn += 1;
        res.setHeader('set-cookie', ['sid=abc; Path=/; HttpOnly']);
        res.end('{}');
        return;
      }
      seen.other += 1;
      res.statusCode = req.headers.cookie?.includes('sid=abc') ? 200 : 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const mix: Mix = {
      scenarios: [
        {
          name: 'one',
          weight: 1,
          requests: [{ name: 'list', method: 'GET', path: '/x?a={ids.first}' }],
        },
      ],
    };
    const fixtures = { ids: { first: 'ct_1' }, ownerA: { email: 'a@example.test', password: 'p' } };
    try {
      const result = await runLoad({
        transport: httpTransport(origin, 'http://web.test'),
        mix,
        fixtures: fixtures as unknown as Fixtures,
        vus: 2,
        durationS: 1,
      });
      expect(seen.signIn).toBe(2);
      expect(seen.badOrigin).toBe(0);
      expect(result.requests['one/list']?.count).toBeGreaterThan(0);
      expect(result.requests['one/list']?.errors).toBe(0);
      expect(result.scenarios.one?.count).toBe(result.requests['one/list']?.count);
    } finally {
      server.close();
    }
  }, 15_000);
});

describe('reports and kill plan', () => {
  it('renders a FAIL load report with the reason and no tables', async () => {
    const text = renderLoadReport(null, ['run aborted: boom'], {
      date: '2026-01-01',
      database: 'x_perf',
      scale: '1 contacts, 2 timeline events in organization A',
    });
    expect(text).toContain('**FAIL**');
    expect(text).toContain('run aborted: boom');
    expect(text).toContain('2 timeline events');
    expect(text).not.toContain('| Name |');
  });

  it('renders a FAIL realtime report', async () => {
    expect(renderRealtimeReport('2026-01-01', [], 'trigger returned HTTP 500')).toContain(
      '**FAIL**: trigger returned HTTP 500',
    );
    expect(renderRealtimeReport('2026-01-01', ['- ok'], null)).toContain('Overall: PASS');
  });

  it('plans a tree kill by pid per platform', async () => {
    expect(killPlan('win32', 42)).toEqual([{ kind: 'taskkill', args: ['/T', '/F', '/PID', '42'] }]);
    expect(killPlan('darwin', 42)).toEqual([
      { kind: 'signal', target: -42, signal: 'SIGTERM' },
      { kind: 'signal', target: -42, signal: 'SIGKILL' },
    ]);
  });

  it('a failed sign-in becomes an error sample, not a rejection', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const result = await runLoad({
        transport: httpTransport(origin, 'http://web.test'),
        mix: { scenarios: [] },
        fixtures: { ownerA: { email: 'a', password: 'b' } } as unknown as Fixtures,
        vus: 2,
        durationS: 1,
      });
      expect(result.requests['setup/sign-in']?.errors).toBe(2);
      expect(verdict(result).length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});

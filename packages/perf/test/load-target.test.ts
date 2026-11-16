import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderLoadReport } from '../src/load/index';
import {
  type LoadResult,
  type Mix,
  runLoad,
  signInOnce,
  singleUser,
  type Transport,
  verdict,
} from '../src/load/runner';
import {
  defaultVus,
  describeTarget,
  describeUsers,
  effectiveMix,
  isGated,
  isSequential,
  parseLoadTarget,
  parseRemoteOrigin,
} from '../src/load/target';
import type { Fixtures } from '../src/seed/fixtures';

const mix = JSON.parse(readFileSync(join(__dirname, '..', 'load', 'mix.json'), 'utf8')) as Mix;
const STAGING_API = 'https://api.staging.example.test';
const STAGING_WEB = 'https://staging.example.test';

describe('parseLoadTarget', () => {
  it('defaults to inprocess and accepts both flag spellings', () => {
    expect(parseLoadTarget([], false)).toEqual({ ok: true, value: { kind: 'inprocess' } });
    expect(parseLoadTarget(['--target', 'wrangler'], false)).toEqual({
      ok: true,
      value: { kind: 'wrangler' },
    });
    expect(parseLoadTarget(['--target=inprocess'], false)).toEqual({
      ok: true,
      value: { kind: 'inprocess' },
    });
  });

  it('refuses an unknown target or a missing value', () => {
    expect(parseLoadTarget(['--target', 'k6'], false)).toEqual({
      ok: false,
      error: '--target must be one of inprocess, wrangler, remote',
    });
    expect(parseLoadTarget(['--target'], false).ok).toBe(false);
  });

  it('needs both origins for remote and keeps only the bare origin', () => {
    expect(
      parseLoadTarget(
        ['--target', 'remote', '--api-origin', `${STAGING_API}/`, `--web-origin=${STAGING_WEB}`],
        false,
      ),
    ).toEqual({
      ok: true,
      value: { kind: 'remote', apiOrigin: STAGING_API, webOrigin: STAGING_WEB },
    });
    expect(parseLoadTarget(['--target', 'remote', '--api-origin', STAGING_API], false)).toEqual({
      ok: false,
      error: '--target remote needs --web-origin <https url>',
    });
    expect(parseLoadTarget(['--target', 'remote', '--web-origin', STAGING_WEB], false)).toEqual({
      ok: false,
      error: '--target remote needs --api-origin <https url>',
    });
  });

  it('refuses origins without --target remote', () => {
    expect(parseLoadTarget(['--api-origin', STAGING_API], false)).toEqual({
      ok: false,
      error: '--api-origin and --web-origin need --target remote',
    });
  });
});

describe('parseRemoteOrigin', () => {
  const parse = (raw: string, force = false) => parseRemoteOrigin('--api-origin', raw, force);

  it('requires https, except http on localhost', () => {
    expect(parse('http://api.staging.example.test')).toEqual({
      ok: false,
      error: '--api-origin must be https (http only for localhost)',
    });
    expect(parse('http://localhost:8787', true)).toEqual({
      ok: true,
      value: 'http://localhost:8787',
    });
    expect(parse('ftp://perf.example.test').ok).toBe(false);
    expect(parse('not a url')).toEqual({ ok: false, error: '--api-origin is not a URL' });
  });

  it('refuses credentials, paths and queries', () => {
    expect(parse('https://u:p@api.staging.example.test')).toEqual({
      ok: false,
      error: '--api-origin must not carry credentials',
    });
    expect(parse('https://api.staging.example.test/api').ok).toBe(false);
    expect(parse('https://api.staging.example.test/?x=1').ok).toBe(false);
  });

  it('refuses a host that names no non-production marker unless --force', () => {
    const prod = parse('https://api.example.test');
    expect(prod.ok).toBe(false);
    if (!prod.ok) expect(prod.error).toMatch(/names none of staging, preview, perf; pass --force/);
    expect(parse('https://api.example.test', true)).toEqual({
      ok: true,
      value: 'https://api.example.test',
    });
    for (const host of [
      'api.staging.example.test',
      'pr-12.preview.example.test',
      'perf.example.test',
    ]) {
      expect(parse(`https://${host}`)).toEqual({ ok: true, value: `https://${host}` });
    }
    expect(parse('http://localhost:8787').ok).toBe(false);
  });
});

describe('effectiveMix', () => {
  const remote = { kind: 'remote', apiOrigin: STAGING_API, webOrigin: STAGING_WEB } as const;

  it('leaves the mix alone for inprocess and wrangler', () => {
    expect(effectiveMix(mix, { kind: 'inprocess' })).toBe(mix);
    expect(effectiveMix(mix, { kind: 'wrangler' })).toBe(mix);
  });

  it('drops every sign-in for remote and rescales the rest to 100', () => {
    expect(mix.scenarios.some((s) => s.name === 'sign-in')).toBe(true);
    const m = effectiveMix(mix, remote);
    expect(m.scenarios.map((s) => s.name)).not.toContain('sign-in');
    for (const s of m.scenarios) {
      for (const r of s.requests) expect(r.path.startsWith('/api/auth/sign-in')).toBe(false);
    }
    expect(m.scenarios.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(100, 9);
    expect(m.scenarios).toHaveLength(mix.scenarios.length - 1);
  });
});

describe('gating per target', () => {
  const over = { count: 5, errors: 0, p50: 900, p95: 1100, p99: 1100, max: 1100, rps: 1 };
  const result: Pick<LoadResult, 'requests'> = { requests: { 'contacts.list/list': over } };

  it('gates inprocess and remote, not wrangler', () => {
    expect(isGated({ kind: 'inprocess' })).toBe(true);
    expect(isGated({ kind: 'remote', apiOrigin: STAGING_API, webOrigin: STAGING_WEB })).toBe(true);
    expect(isGated({ kind: 'wrangler' })).toBe(false);
  });

  it('makes wrangler fail only on errors', () => {
    expect(verdict(result, { gate: false })).toEqual([]);
    expect(verdict(result)).toEqual(['contacts.list/list: p95 1100.0 ms over 150 ms']);
    const errored = { requests: { 'contacts.list/list': { ...over, errors: 2 } } };
    expect(verdict(errored, { gate: false })).toEqual(['contacts.list/list: 2 errors']);
  });

  it('renders the wrangler report as informational with the single-user line', () => {
    const text = renderLoadReport(
      { vus: 10, durationS: 30, elapsedS: 30, requests: result.requests, scenarios: {} },
      [],
      {
        date: '2026-01-01',
        database: 'x_perf',
        scale: 's',
        target: { kind: 'wrangler' },
        singleUser: [
          { label: 'health', medianMs: 51.24, errors: 0 },
          { label: 'contacts list', medianMs: 70, errors: 0 },
        ],
      },
    );
    expect(text).toContain('Overall: PASS (informational, no gate)');
    expect(text).toContain('- Target: wrangler (informational, no gate).');
    expect(text).toContain('- Budget: none (informational, no gate)');
    expect(text).toContain(
      '- Single user: median of 15 sequential requests on one session, health 51.2 ms, contacts list 70.0 ms',
    );
  });

  it('names the inprocess target and what it leaves out', () => {
    const text = renderLoadReport(null, [], { date: 'd', database: 'x_perf', scale: 's' }, 1);
    expect(text).toContain('- Target: inprocess.');
    expect(text).toContain('leaves out the Workers runtime and the network');
    expect(text).toContain('- Budget: p95 at most 150 ms');
    expect(text).toContain('- Users: 1 virtual user, one request at a time (Rulings L-b and L-c');
    expect(text).toContain('throughput is gated on staging');
    expect(text).toContain('(go-live step 6a)');
  });

  it('defaults to 1 user in-process and 10 elsewhere (Ruling L-b)', () => {
    const remote = { kind: 'remote', apiOrigin: STAGING_API, webOrigin: STAGING_WEB } as const;
    expect(defaultVus({ kind: 'inprocess' })).toBe(1);
    expect(defaultVus(remote)).toBe(10);
    expect(defaultVus({ kind: 'wrangler' })).toBe(10);
    expect(describeUsers(remote, 10)).toContain('10 virtual users');
    expect(describeUsers(remote, 10)).toContain('throughput on real infrastructure');
  });

  it('names only the remote hosts, never a full URL', () => {
    const line = describeTarget({
      kind: 'remote',
      apiOrigin: STAGING_API,
      webOrigin: STAGING_WEB,
    });
    expect(line).toContain('API host api.staging.example.test, web host staging.example.test');
    expect(line).not.toContain('https://');
    expect(line).toContain('the sign-in scenario is left out');
  });
});

describe('shared transport', () => {
  function fakeTransport(log: string[]): Transport {
    return {
      signIn: async () => {
        log.push('sign-in');
        return 'sid=1';
      },
      send: async (method, path, _body, cookie) => {
        log.push(`${method} ${path} ${cookie}`);
        return !path.includes('bad');
      },
    };
  }

  it('signs in once across every virtual user with signInOnce', async () => {
    const log: string[] = [];
    const fixtures = { ownerA: { email: 'a@example.test', password: 'p' } } as unknown as Fixtures;
    const oneScenario: Mix = {
      scenarios: [
        { name: 's', weight: 1, requests: [{ name: 'list', method: 'GET', path: '/x' }] },
      ],
    };
    const result = await runLoad({
      transport: signInOnce(fakeTransport(log)),
      mix: oneScenario,
      fixtures,
      vus: 3,
      durationS: 1,
    });
    expect(log.filter((l) => l === 'sign-in')).toHaveLength(1);
    expect(result.requests['s/list']?.errors).toBe(0);
  });

  it('fires a scenario one request at a time when sequential, in parallel otherwise', async () => {
    const peakInFlight = async (sequential: boolean) => {
      let inFlight = 0;
      let peak = 0;
      const transport: Transport = {
        signIn: async () => 'sid=1',
        send: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((r) => setTimeout(r, 5));
          inFlight -= 1;
          return true;
        },
      };
      const fourAtOnce: Mix = {
        scenarios: [
          {
            name: 'page',
            weight: 1,
            requests: ['a', 'b', 'c', 'd'].map((p) => ({
              name: 'list',
              method: 'GET',
              path: `/${p}`,
            })),
          },
        ],
      };
      const result = await runLoad({
        transport,
        mix: fourAtOnce,
        fixtures: { ownerA: { email: 'a@example.test', password: 'p' } } as unknown as Fixtures,
        vus: 1,
        durationS: 1,
        sequential,
      });
      expect(result.requests['page/list']?.count).toBeGreaterThan(0);
      return peak;
    };
    expect(await peakInFlight(true)).toBe(1);
    expect(await peakInFlight(false)).toBe(4);
    expect(isSequential({ kind: 'inprocess' })).toBe(true);
    expect(isSequential({ kind: 'wrangler' })).toBe(false);
    expect(isSequential({ kind: 'remote', apiOrigin: STAGING_API, webOrigin: STAGING_WEB })).toBe(
      false,
    );
    expect(describeUsers({ kind: 'inprocess' }, 1)).toContain(
      '1 virtual user, one request at a time',
    );
  });

  it('times sequential single-user requests and counts errors', async () => {
    const log: string[] = [];
    const r = await singleUser(
      fakeTransport(log),
      'sid=1',
      [
        { label: 'ok', method: 'GET', path: '/ok' },
        { label: 'bad', method: 'GET', path: '/bad' },
      ],
      3,
    );
    expect(log).toHaveLength(6);
    expect(r.map((x) => [x.label, x.errors])).toEqual([
      ['ok', 0],
      ['bad', 3],
    ]);
  });
});

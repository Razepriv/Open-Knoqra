import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATED, type Mix, pickScenario, resolveRequest } from '../src/load/runner';
import { buildFixtures, planSeed } from '../src/seed/fixtures';
import { mulberry32 } from '../src/seed/random';
import { SAMPLE_PHASE1_RAW } from './phase1-raw';

const mix = JSON.parse(readFileSync(join(__dirname, '..', 'load', 'mix.json'), 'utf8')) as Mix;
const plan = planSeed(7, 0.01);
const fixtures = buildFixtures(plan, {
  database: 'knoqra_perf_test',
  contactsDeep: { name: 'a', id: 'ct_a' },
  timelineDeep: { occurredAt: '2026-01-01T00:00:00.000Z', id: 'te_a' },
  phase1: SAMPLE_PHASE1_RAW,
});

describe('mix.json', () => {
  it('has weights summing to 100 and the expected scenarios', () => {
    expect(mix.scenarios.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(mix.scenarios.map((s) => s.name)).toEqual([
      'contacts.list',
      'contacts.list.deep',
      'contacts.search',
      'contact360',
      'timeline.deep',
      'inbox',
      'inbox.search',
      'thread',
      'calls',
      'tasks',
      'notifications',
      'sign-in',
    ]);
  });

  it('resolves every request against generated fixtures, for several iterations', () => {
    for (const scenario of mix.scenarios) {
      for (const request of scenario.requests) {
        for (let i = 0; i < 8; i++) {
          const { path, body } = resolveRequest(request, fixtures, i);
          expect(path).not.toMatch(/[{}]/);
          if (request.body !== undefined) expect(body).toBeDefined();
        }
      }
    }
  });

  it('rotates search over four fixture keys', () => {
    const search = mix.scenarios.find((s) => s.name === 'contacts.search')?.requests[0];
    if (!search) throw new Error('missing search request');
    const paths = new Set([0, 1, 2, 3, 4].map((i) => resolveRequest(search, fixtures, i).path));
    expect(paths.size).toBe(4);
  });

  it('sign-in body carries owner A credentials', () => {
    const signIn = mix.scenarios.find((s) => s.name === 'sign-in')?.requests[0];
    if (!signIn) throw new Error('missing sign-in');
    expect(resolveRequest(signIn, fixtures, 0).body).toEqual({
      email: fixtures.ownerA.email,
      password: fixtures.ownerA.password,
    });
  });

  it('gates every request except sign-in and the two M1 contact 360 side calls', () => {
    // permissions and duplicates on the contact page have been informational since M1.
    const ungated = new Set(['contact360/permissions', 'contact360/duplicates']);
    for (const scenario of mix.scenarios) {
      if (scenario.name === 'sign-in') continue;
      for (const request of scenario.requests) {
        const key = `${scenario.name}/${request.name}`;
        if (ungated.has(key)) continue;
        expect(GATED.has(request.name ?? ''), key).toBe(true);
      }
    }
  });

  it('picks scenarios deterministically for a seed', () => {
    const picks = (seed: number) => {
      const rand = mulberry32(seed);
      return Array.from({ length: 20 }, () => pickScenario(mix, rand).name);
    };
    expect(picks(3)).toEqual(picks(3));
    expect(picks(3)).not.toEqual(picks(4));
  });
});

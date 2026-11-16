import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config';
import { REALTIME } from '../src/realtime/config';
import { hasDurableObjects, openInBatches, realtimeConfigProblem } from '../src/realtime/index';

describe('openInBatches', () => {
  it('opens every socket and never more than `concurrency` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    let opened = 0;
    await openInBatches(23, 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      opened += 1;
    });
    expect(opened).toBe(23);
    expect(peak).toBe(10);
  });

  it('rejects when one open fails', async () => {
    await expect(
      openInBatches(5, 2, async () => {
        throw new Error('socket error');
      }),
    ).rejects.toThrow('socket error');
  });
});

const withoutBindings = `{
  // no Durable Objects yet
  "name": "api",
  "compatibility_date": "2026-01-01"
}`;

describe('hasDurableObjects', () => {
  it('is false for a config without durable_objects (fixture, not the live file)', () => {
    expect(hasDurableObjects(withoutBindings)).toBe(false);
  });

  it('is true for JSONC with comments and a binding', () => {
    const text = `{
      // a comment with "quotes" and /* nested-looking */ text
      "name": "x", /* block */
      "url": "http://example.test/a//b",
      "durable_objects": { "bindings": [{ "name": "X", "class_name": "Y" }] }
    }`;
    expect(hasDurableObjects(text)).toBe(true);
  });

  it('accepts trailing commas and keeps commas inside strings', () => {
    const text = `{
      "note": "a, }",
      "durable_objects": { "bindings": [{ "name": "X", "class_name": "Y",},], },
    }`;
    expect(hasDurableObjects(text)).toBe(true);
  });

  it('is false for empty bindings', () => {
    expect(hasDurableObjects('{ "durable_objects": { "bindings": [] } }')).toBe(false);
  });

  it('throws on invalid JSON instead of reporting no bindings', () => {
    expect(() => hasDurableObjects('not json')).toThrow(/not valid JSONC/);
    expect(() => hasDurableObjects('{ "a": }')).toThrow(/not valid JSONC/);
  });
});

describe('realtimeConfigProblem', () => {
  it('fails when the trigger or expected type is missing', () => {
    const message = /configure realtime\/config\.ts trigger and expectType/;
    expect(realtimeConfigProblem({ trigger: null, expectType: null })).toMatch(message);
    expect(
      realtimeConfigProblem({ trigger: { method: 'POST', path: '/x' }, expectType: null }),
    ).toMatch(message);
    expect(realtimeConfigProblem({ trigger: null, expectType: 'x' })).toMatch(message);
  });

  it('passes when both are configured', () => {
    expect(
      realtimeConfigProblem({
        trigger: { method: 'POST', path: '/x' },
        expectType: 'contact.created',
      }),
    ).toBeNull();
  });

  it('is configured for the live wrangler.jsonc, which has Durable Object bindings', () => {
    const live = readFileSync(join(REPO_ROOT, 'apps', 'api', 'wrangler.jsonc'), 'utf8');
    expect(hasDurableObjects(live)).toBe(true);
    expect(realtimeConfigProblem(REALTIME)).toBeNull();
    expect(REALTIME.trigger?.path).toBe('/api/v1/wallet/caps');
    expect(REALTIME.expectType).toBe('wallet.updated');
  });
});

import { describe, expect, it } from 'vitest';
import { realtimeReportPath, realtimeUrl } from '../src/realtime/index';
import { makeStopper, runShutdown } from '../src/server';

describe('runShutdown', () => {
  it('awaits an async before, then stops, then exits', async () => {
    const order: string[] = [];
    await runShutdown(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('before');
      },
      async () => {
        order.push('stop');
      },
      (code) => order.push(`exit ${code}`),
      130,
    );
    expect(order).toEqual(['before', 'stop', 'exit 130']);
  });

  it('still stops and exits when before throws or is absent', async () => {
    const order: string[] = [];
    const stop = async () => {
      order.push('stop');
    };
    await runShutdown(
      () => {
        throw new Error('boom');
      },
      stop,
      (c) => order.push(`exit ${c}`),
      143,
    );
    await runShutdown(undefined, stop, (c) => order.push(`exit ${c}`), 143);
    expect(order).toEqual(['stop', 'exit 143', 'stop', 'exit 143']);
  });
});

describe('realtime strings', () => {
  it('builds the WebSocket URL', () => {
    expect(realtimeUrl('http://localhost:8879', '/api/v1/realtime')).toBe(
      'ws://localhost:8879/api/v1/realtime',
    );
    expect(realtimeUrl('https://api.example.test', '/x')).toBe('wss://api.example.test/x');
  });

  it('builds the report path', () => {
    expect(realtimeReportPath('2026-11-12')).toBe('docs/perf/2026-11-12-realtime.md');
  });
});

describe('makeStopper', () => {
  it('kills each child once, shares the in-flight promise and is idempotent', async () => {
    const killed: string[] = [];
    const list = ['api', 'web'];
    const stop = makeStopper(list, async (child) => {
      await new Promise((r) => setTimeout(r, 5));
      killed.push(child);
    });
    const first = stop();
    const second = stop();
    expect(second).toBe(first);
    await first;
    await stop();
    expect(killed.sort()).toEqual(['api', 'web']);
    expect(list).toEqual([]);
  });

  it('stops children registered after an earlier stop', async () => {
    const killed: string[] = [];
    const list = ['a'];
    const stop = makeStopper(list, async (c) => {
      killed.push(c);
    });
    await stop();
    list.push('b');
    await stop();
    expect(killed).toEqual(['a', 'b']);
  });
});

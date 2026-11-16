import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createInProcessApi } from '../src/app-harness';
import { captureQueries } from '../src/capture';

const { Client } = createRequire(import.meta.resolve('@knoqra/db'))('pg') as typeof import('pg');
type AnyFn = (...args: unknown[]) => unknown;
const proto = Client.prototype as unknown as { query: AnyFn };

async function withFake<T>(fn: () => Promise<T>): Promise<T> {
  const original = proto.query;
  proto.query = (async () => 'fake-result') as AnyFn;
  try {
    return await fn();
  } finally {
    proto.query = original;
  }
}

describe('captureQueries', () => {
  it('takes values from a separate argument when the config object has none', async () => {
    await withFake(async () => {
      const { statements } = await captureQueries(async () => {
        await proto.query.call({}, { text: 'select 4', rowMode: 'array' }, [7]);
      });
      expect(statements).toEqual([{ text: 'select 4', values: [7] }]);
    });
  });

  it('records both call forms in order and returns the original result', async () => {
    await withFake(async () => {
      const { result, statements } = await captureQueries(async () => {
        const a = await proto.query.call({}, 'select 1', [1]);
        const b = await proto.query.call({}, { text: 'select 2', values: [2, 3] });
        return [a, b];
      });
      expect(result).toEqual(['fake-result', 'fake-result']);
      expect(statements).toEqual([
        { text: 'select 1', values: [1] },
        { text: 'select 2', values: [2, 3] },
      ]);
    });
  });

  it('restores Client.prototype.query after resolve and reject', async () => {
    await withFake(async () => {
      const before = proto.query;
      await captureQueries(async () => 1);
      expect(proto.query).toBe(before);
      await expect(
        captureQueries(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(proto.query).toBe(before);
    });
  });
});

describe('createInProcessApi', () => {
  it('serves /api/health in Node (503 degraded when the database is unreachable)', async () => {
    const api = createInProcessApi({
      database: 'nonexistent_perf',
      adminUrl: 'postgres://x:x@127.0.0.1:1/nonexistent_perf',
      appUrl: 'postgres://x:x@127.0.0.1:1/nonexistent_perf',
      force: false,
    });
    const r = await api.request('GET', '/api/health');
    await api.flush();
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ status: 'degraded', db: 'unreachable' });
  });
});

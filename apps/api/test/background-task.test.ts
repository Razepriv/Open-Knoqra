import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackgroundTask } from '../src/lib/auth-context';

afterEach(() => vi.restoreAllMocks());

describe('runBackgroundTask', () => {
  it('logs a rejected task without throwing, with and without a host', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handed: Promise<unknown>[] = [];
    const failing = () => Promise.reject(new Error('Resend request failed with status 500'));

    expect(() => runBackgroundTask(failing(), (p) => handed.push(p))).not.toThrow();
    await Promise.all(handed);
    runBackgroundTask(failing());
    await new Promise((r) => setTimeout(r, 0));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]?.[0])).toContain('auth.background_task_failed');
  });

  it('survives a host waitUntil that throws', () => {
    expect(() =>
      runBackgroundTask(Promise.resolve(), () => {
        throw new Error('no execution context');
      }),
    ).not.toThrow();
  });
});

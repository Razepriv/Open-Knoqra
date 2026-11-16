import { describe, expect, it, vi } from 'vitest';
import { isTransientConflict, retryOnConflict } from '../src/lib/retry';

/** Shaped like drizzle-orm's DrizzleQueryError wrapping a pg DatabaseError. */
function drizzleError(code: string): Error {
  const pgError = Object.assign(new Error('deadlock detected'), { name: 'DatabaseError', code });
  const error = new Error('Failed query: select 1', { cause: pgError });
  error.name = 'DrizzleQueryError';
  return error;
}

describe('isTransientConflict', () => {
  it('finds a deadlock or serialization failure in the cause chain', () => {
    expect(isTransientConflict(drizzleError('40P01'))).toBe(true);
    expect(isTransientConflict(drizzleError('40001'))).toBe(true);
    expect(isTransientConflict(Object.assign(new Error('raw'), { code: '40P01' }))).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isTransientConflict(drizzleError('23505'))).toBe(false);
    expect(isTransientConflict(new Error('plain'))).toBe(false);
    expect(isTransientConflict('40P01')).toBe(false);
    expect(isTransientConflict(undefined)).toBe(false);
  });
});

describe('retryOnConflict', () => {
  it('returns the first result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retryOnConflict(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(['40P01', '40001'])('retries once after %s', async (code) => {
    const fn = vi.fn().mockRejectedValueOnce(drizzleError(code)).mockResolvedValueOnce('second');
    await expect(retryOnConflict(fn)).resolves.toBe('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries only once, then lets the error through', async () => {
    const second = drizzleError('40P01');
    const fn = vi.fn().mockRejectedValueOnce(drizzleError('40P01')).mockRejectedValueOnce(second);
    await expect(retryOnConflict(fn)).rejects.toBe(second);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never retries any other error', async () => {
    const error = drizzleError('23505');
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retryOnConflict(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

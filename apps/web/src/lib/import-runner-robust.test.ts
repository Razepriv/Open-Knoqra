import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from './api';
import {
  type BatchResult,
  describeImportError,
  failedSummary,
  type ImportBatchFn,
  normalizeImportFileName,
  runImport,
} from './import-runner';

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ displayName: `n${i}`, phone: `p${i}` }));
}

const created = (index: number): BatchResult => ({
  index,
  status: 'created',
  contactId: 'ct',
  error: null,
});

const base = { fileName: 'contacts.csv', onDuplicate: 'skip' } as const;
const noWait = async () => {};

function flaky(failures: unknown[]) {
  let call = 0;
  return vi.fn<ImportBatchFn>(async (request) => {
    const failure = failures[call];
    call += 1;
    if (failure) throw failure;
    return request.rows.map((_, index) => created(index));
  });
}

describe('runImport retries', () => {
  it.each([
    ['a network failure', new NetworkError()],
    ['a 5xx answer', new ApiError(503, 'Unavailable')],
    ['a 429 answer', new ApiError(429, 'Slow down')],
  ])('retries a batch once after %s and carries on', async (_name, failure) => {
    const importBatch = flaky([failure]);
    const waits: number[] = [];
    const summary = await runImport({
      ...base,
      rows: rows(3),
      importBatch,
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    expect(importBatch).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(summary).toMatchObject({ status: 'completed', processed: 3, error: null });
  });

  it('gives up when the retry fails too, and keeps the second error', async () => {
    const second = new ApiError(502, 'Bad gateway');
    const importBatch = flaky([new ApiError(500, 'Boom'), second]);
    const summary = await runImport({ ...base, rows: rows(3), importBatch, wait: noWait });
    expect(importBatch).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ status: 'failed', processed: 0 });
    expect(summary.error).toBe(second);
  });

  it.each([
    ['a 400', new ApiError(400, 'Bad body')],
    ['a 401', new ApiError(401, 'Sign in')],
    ['a 413', new ApiError(413, 'Too big')],
  ])('does not retry %s', async (_name, failure) => {
    const importBatch = flaky([failure]);
    const summary = await runImport({ ...base, rows: rows(3), importBatch, wait: noWait });
    expect(importBatch).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('failed');
    expect(summary.error).toBe(failure);
  });

  it('does not retry when the user cancelled during the wait', async () => {
    const controller = new AbortController();
    const importBatch = flaky([new ApiError(500, 'Boom')]);
    const summary = await runImport({
      ...base,
      rows: rows(3),
      importBatch,
      signal: controller.signal,
      wait: async () => controller.abort(),
    });
    expect(importBatch).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('failed');
  });
});

describe('runImport result validation', () => {
  const answer = (indexes: number[]) =>
    vi.fn<ImportBatchFn>(async () => indexes.map((index) => created(index)));

  it.each([
    ['a repeated index', [0, 0]],
    ['an index past the end', [0, 2]],
    ['a negative index', [-1, 0]],
    ['a fractional index', [0, 0.5]],
  ])('treats %s as a failed batch and counts nothing from it', async (_name, indexes) => {
    const summary = await runImport({ ...base, rows: rows(2), importBatch: answer(indexes) });
    expect(summary.status).toBe('failed');
    expect(summary.processed).toBe(0);
    expect(summary.counts.created).toBe(0);
  });
});

describe('runImport stopping point', () => {
  it('reports the row where a failed batch began', async () => {
    let call = 0;
    const importBatch = vi.fn<ImportBatchFn>(async (request) => {
      call += 1;
      if (call === 2) throw new ApiError(400, 'Nope');
      return request.rows.map((_, index) => created(index));
    });
    const summary = await runImport({
      ...base,
      rows: rows(700),
      importBatch,
      rowNumbers: Array.from({ length: 700 }, (_, i) => i + 5),
    });
    expect(summary.status).toBe('failed');
    expect(summary.stoppedAtRow).toBe(505);
  });

  it('reports the first unsent row when cancelled, and null when finished', async () => {
    const controller = new AbortController();
    const importBatch = vi.fn<ImportBatchFn>(async (request) =>
      request.rows.map((_, index) => created(index)),
    );
    const cancelled = await runImport({
      ...base,
      rows: rows(1000),
      importBatch,
      signal: controller.signal,
      onProgress: ({ batch }) => {
        if (batch === 1) controller.abort();
      },
    });
    expect(cancelled.stoppedAtRow).toBe(501);
    const done = await runImport({ ...base, rows: rows(2), importBatch });
    expect(done.stoppedAtRow).toBeNull();
  });
});

describe('describeImportError', () => {
  it('says plainly when KNOQRA cannot be reached', () => {
    const unreachable = "We couldn't reach KNOQRA.";
    expect(describeImportError(new NetworkError())).toBe(unreachable);
    expect(describeImportError(new TypeError('Failed to fetch'))).toBe(unreachable);
    expect(
      describeImportError(new TypeError('NetworkError when attempting to fetch resource.')),
    ).toBe(unreachable);
    expect(describeImportError(new TypeError('Load failed'))).toBe(unreachable);
  });

  it('uses the server message for an API error', () => {
    expect(describeImportError(new ApiError(413, 'Too many rows.'))).toBe('Too many rows.');
  });

  it('uses our own wording for a 400, not the server text', () => {
    const message = describeImportError(new ApiError(400, 'fileName: String must contain at most'));
    expect(message).not.toContain('fileName');
    expect(message).toMatch(/couldn't accept this file/);
  });

  it('falls back to a generic line for anything else', () => {
    expect(describeImportError('boom')).toBe('Something went wrong while importing.');
    expect(
      describeImportError(new Error('The server returned an unexpected answer for this batch.')),
    ).toBe('The server returned an unexpected answer for this batch.');
  });
});

describe('failedSummary', () => {
  it('stands in for a run that threw before it could report', () => {
    const error = new Error('boom');
    expect(failedSummary(error, 42)).toEqual({
      status: 'failed',
      outcomes: [],
      counts: { created: 0, updated: 0, skipped: 0, rejected: 0 },
      processed: 0,
      total: 42,
      error,
      stoppedAtRow: null,
    });
  });
});

describe('normalizeImportFileName', () => {
  it('leaves an ordinary name alone', () => {
    expect(normalizeImportFileName('contacts.csv')).toBe('contacts.csv');
  });

  it('drops control characters', () => {
    expect(normalizeImportFileName('con\u0000tacts\n.csv')).toBe('contacts.csv');
  });

  it('cuts a long name to 200 UTF-16 units and keeps the extension', () => {
    const result = normalizeImportFileName(`${'a'.repeat(300)}.csv`);
    expect(result).toHaveLength(200);
    expect(result.endsWith('.csv')).toBe(true);
  });

  // The server counts string.length (UTF-16 units), so an emoji counts as two.
  const wellFormed = (value: string) => () => encodeURIComponent(value); // throws on a lone surrogate

  it('counts an emoji as two units: 150 emoji plus ".csv" is cut to fit', () => {
    const result = normalizeImportFileName(`${'😀'.repeat(150)}.csv`);
    expect(result).toBe(`${'😀'.repeat(98)}.csv`);
    expect(result).toHaveLength(200);
    expect(wellFormed(result)).not.toThrow();
  });

  it('never splits a surrogate pair at the cut, with or without an extension', () => {
    const odd = normalizeImportFileName(`a${'😀'.repeat(150)}.csv`);
    expect(odd).toBe(`a${'😀'.repeat(97)}.csv`);
    expect(odd).toHaveLength(199);
    expect(wellFormed(odd)).not.toThrow();

    const bare = normalizeImportFileName(`a${'😀'.repeat(150)}`);
    expect(bare).toBe(`a${'😀'.repeat(99)}`);
    expect(wellFormed(bare)).not.toThrow();
  });

  it('leaves a name of exactly 200 units alone, emoji included', () => {
    const name = `${'😀'.repeat(98)}.csv`;
    expect(normalizeImportFileName(name)).toBe(name);
  });

  it('falls back when nothing is left', () => {
    expect(normalizeImportFileName('\u0001\u0002')).toBe('import.csv');
  });

  it('is what the runner sends', async () => {
    const importBatch = vi.fn<ImportBatchFn>(async () => [created(0)]);
    await runImport({ ...base, fileName: `${'x'.repeat(250)}.csv`, rows: rows(1), importBatch });
    const request = importBatch.mock.calls[0]?.[0];
    expect(Array.from(request?.fileName ?? '')).toHaveLength(200);
  });
});

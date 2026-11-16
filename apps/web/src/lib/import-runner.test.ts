import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  BATCH_SIZE,
  type BatchResult,
  type ImportBatchFn,
  type ImportProgress,
  runImport,
  shouldBlockImportExit,
} from './import-runner';

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ displayName: `n${i}`, phone: `p${i}` }));
}

/** A fake server: every row is created, unless `override` decides otherwise. */
function fakeServer(
  override: (index: number, batchNo: number) => Partial<BatchResult> = () => ({}),
) {
  let batchNo = 0;
  const importBatch = vi.fn<ImportBatchFn>(async (request) => {
    batchNo += 1;
    return request.rows.map(
      (_, index): BatchResult => ({
        index,
        status: 'created',
        contactId: `ct_${batchNo}_${index}`,
        error: null,
        ...override(index, batchNo),
      }),
    );
  });
  return importBatch;
}

const base = { fileName: 'contacts.csv', onDuplicate: 'skip' } as const;

describe('runImport', () => {
  it('sends 500-row batches one after another and reports the totals', async () => {
    const importBatch = fakeServer();
    const summary = await runImport({ ...base, rows: rows(1203), importBatch });

    expect(importBatch.mock.calls.map(([request]) => request.rows.length)).toEqual([500, 500, 203]);
    expect(BATCH_SIZE).toBe(500);
    expect(summary).toMatchObject({
      status: 'completed',
      total: 1203,
      processed: 1203,
      counts: { created: 1203, updated: 0, skipped: 0, rejected: 0 },
      error: null,
    });
    expect(summary.outcomes).toHaveLength(1203);
  });

  it('never has two batches in flight at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const importBatch = vi.fn<ImportBatchFn>(async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return request.rows.map((_, index) => ({
        index,
        status: 'created',
        contactId: 'ct',
        error: null,
      }));
    });
    await runImport({ ...base, rows: rows(1100), importBatch });
    expect(peak).toBe(1);
  });

  it('passes the file name and duplicate mode with every batch', async () => {
    const importBatch = fakeServer();
    await runImport({ ...base, onDuplicate: 'update', rows: rows(501), importBatch });
    for (const [request] of importBatch.mock.calls) {
      expect(request).toMatchObject({ fileName: 'contacts.csv', onDuplicate: 'update' });
    }
  });

  it('adds the batch offset to each result index', async () => {
    const importBatch = fakeServer((index, batchNo) =>
      index === 3 && batchNo === 2
        ? {
            status: 'rejected',
            contactId: null,
            error: { code: 'validation_error', message: 'Email is not valid' },
          }
        : {},
    );
    const summary = await runImport({ ...base, rows: rows(600), importBatch });
    const rejected = summary.outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toEqual([
      {
        index: 503,
        rowNumber: 504,
        status: 'rejected',
        contactId: null,
        message: 'Email is not valid',
      },
    ]);
    expect(summary.counts.rejected).toBe(1);
    expect(summary.counts.created).toBe(599);
  });

  it('uses the file-level row numbers it is given, gaps and all', async () => {
    const importBatch = fakeServer((index) =>
      index === 0
        ? {
            status: 'rejected',
            contactId: null,
            error: { code: 'validation_error', message: 'Phone is required' },
          }
        : {},
    );
    const summary = await runImport({ ...base, rows: rows(2), importBatch, rowNumbers: [3, 7] });
    expect(summary.outcomes.map((o) => o.rowNumber)).toEqual([3, 7]);
  });

  it('rewrites "Duplicate of row N" to a file-level row number', async () => {
    const importBatch = fakeServer((index, batchNo) =>
      batchNo === 2 && index === 5
        ? {
            status: 'skipped',
            contactId: null,
            error: { code: 'duplicate_contact', message: 'Duplicate of row 2' },
          }
        : {},
    );
    const summary = await runImport({ ...base, rows: rows(520), importBatch });
    const skipped = summary.outcomes.find((outcome) => outcome.status === 'skipped');
    expect(skipped?.message).toBe('Duplicate of row 502');

    const withHeader = fakeServer((index, batchNo) =>
      batchNo === 2 && index === 5
        ? {
            status: 'skipped',
            contactId: null,
            error: { code: 'duplicate_contact', message: 'Duplicate of row 2' },
          }
        : {},
    );
    const second = await runImport({
      ...base,
      rows: rows(520),
      importBatch: withHeader,
      rowNumbers: Array.from({ length: 520 }, (_, i) => i + 2),
    });
    expect(second.outcomes.find((o) => o.status === 'skipped')?.message).toBe(
      'Duplicate of row 503',
    );
  });

  it('leaves other messages untouched', async () => {
    const importBatch = fakeServer(() => ({
      status: 'skipped',
      contactId: 'ct_x',
      error: { code: 'duplicate_contact', message: 'Already in your contacts' },
    }));
    const summary = await runImport({ ...base, rows: rows(1), importBatch });
    expect(summary.outcomes[0]?.message).toBe('Already in your contacts');
    expect(summary.counts.skipped).toBe(1);
  });

  it('counts updated rows', async () => {
    const importBatch = fakeServer(() => ({ status: 'updated' }));
    const summary = await runImport({ ...base, rows: rows(3), importBatch });
    expect(summary.counts.updated).toBe(3);
  });

  it('reports progress before the first batch and after each one', async () => {
    const seen: ImportProgress[] = [];
    await runImport({
      ...base,
      rows: rows(1001),
      importBatch: fakeServer(),
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen).toEqual([
      { batch: 0, batches: 3, processed: 0, total: 1001 },
      { batch: 1, batches: 3, processed: 500, total: 1001 },
      { batch: 2, batches: 3, processed: 1000, total: 1001 },
      { batch: 3, batches: 3, processed: 1001, total: 1001 },
    ]);
  });

  it('stops between batches when cancelled and keeps what was already imported', async () => {
    const controller = new AbortController();
    const importBatch = fakeServer();
    const summary = await runImport({
      ...base,
      rows: rows(1500),
      importBatch,
      signal: controller.signal,
      onProgress: ({ batch }) => {
        if (batch === 1) controller.abort();
      },
    });
    expect(importBatch).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      status: 'cancelled',
      processed: 500,
      total: 1500,
      error: null,
    });
    expect(summary.outcomes).toHaveLength(500);
  });

  it('does not send anything when cancelled before the first batch', async () => {
    const controller = new AbortController();
    controller.abort();
    const importBatch = fakeServer();
    const summary = await runImport({
      ...base,
      rows: rows(10),
      importBatch,
      signal: controller.signal,
    });
    expect(importBatch).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ status: 'cancelled', processed: 0 });
  });

  it('stops at a failed batch, keeps earlier results and carries the error', async () => {
    const failure = new ApiError(400, 'Something went wrong.');
    let call = 0;
    const importBatch = vi.fn<ImportBatchFn>(async (request) => {
      call += 1;
      if (call === 2) throw failure;
      return request.rows.map((_, index) => ({
        index,
        status: 'created',
        contactId: 'ct',
        error: null,
      }));
    });
    const summary = await runImport({ ...base, rows: rows(1200), importBatch });
    expect(importBatch).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ status: 'failed', processed: 500, total: 1200 });
    expect(summary.error).toBe(failure);
    expect(summary.counts.created).toBe(500);
  });

  it('treats a response with the wrong number of results as a failed batch', async () => {
    const importBatch = vi.fn<ImportBatchFn>(async () => []);
    const summary = await runImport({ ...base, rows: rows(2), importBatch });
    expect(summary.status).toBe('failed');
    expect(summary.error).toBeInstanceOf(Error);
    expect(summary.processed).toBe(0);
  });
});

describe('shouldBlockImportExit', () => {
  it('asks before leaving a running import for any page in the app', () => {
    expect(shouldBlockImportExit(false, '/')).toBe(true);
    expect(shouldBlockImportExit(false, '/contacts')).toBe(true);
    expect(shouldBlockImportExit(false, '/settings')).toBe(true);
  });

  it('lets sign-out through: the session is already gone, so the run cannot continue', () => {
    expect(shouldBlockImportExit(false, '/sign-in')).toBe(false);
  });

  it('never blocks once the run has seen its session end', () => {
    expect(shouldBlockImportExit(true, '/contacts')).toBe(false);
    expect(shouldBlockImportExit(true, '/sign-in')).toBe(false);
  });
});

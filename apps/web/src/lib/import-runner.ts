import type { components } from '@knoqra/api-client';
import { ApiError, api, NetworkError, throwIfFailed } from './api';
import type { ImportRow } from './csv';

export const BATCH_SIZE = 500;
/** How long to wait before the one automatic retry of a batch. */
export const RETRY_DELAY_MS = 1500;

export type ImportResult = components['schemas']['ImportResult'];
export type BatchResult = ImportResult['results'][number];
export type RowStatus = BatchResult['status'];
export type DuplicateMode = components['schemas']['ImportRequest']['onDuplicate'];

export interface BatchRequest {
  fileName: string;
  onDuplicate: DuplicateMode;
  rows: ImportRow[];
}

/** Sends one batch and returns its per-row results, in request order. Throws on a failed request. */
export type ImportBatchFn = (request: BatchRequest) => Promise<BatchResult[]>;

/** The real batch call: POST /api/v1/contacts/import through the generated client. */
export const postImportBatch: ImportBatchFn = async (request) => {
  const result = throwIfFailed(
    await api.POST('/api/v1/contacts/import', { body: request }),
    'Could not import these contacts.',
  );
  return result.results;
};

/** The outcome of one file row, with file-level numbering. */
export interface RowOutcome {
  /** 0-based position of the row among the file's data rows. */
  index: number;
  /** The row's number in the file (see `RunImportOptions.rowNumbers`). */
  rowNumber: number;
  status: RowStatus;
  contactId: string | null;
  message: string | null;
}

export interface ImportCounts {
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
}

export interface ImportProgress {
  /** Batches finished so far. */
  batch: number;
  batches: number;
  processed: number;
  total: number;
}

export interface ImportSummary {
  status: 'completed' | 'cancelled' | 'failed';
  outcomes: RowOutcome[];
  counts: ImportCounts;
  processed: number;
  total: number;
  /** Set when `status` is `failed`: the thrown error, kept as-is so callers can classify it. */
  error: unknown;
  /**
   * The file row where the batch that did not finish begins. Rows from here on were not sent
   * (cancelled) or may or may not have been imported (failed). Null when everything finished.
   */
  stoppedAtRow: number | null;
}

export interface RunImportOptions {
  rows: readonly ImportRow[];
  fileName: string;
  onDuplicate: DuplicateMode;
  importBatch: ImportBatchFn;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  /** The file-level row number of each row, parallel to `rows`. Defaults to 1, 2, 3, ... */
  rowNumbers?: readonly number[];
  /** Waits before a retry. Injectable so tests need not sleep. */
  wait?: (ms: number) => Promise<void>;
}

const DUPLICATE_OF_ROW = /^Duplicate of row (\d+)$/;

const UNREACHABLE = "We couldn't reach KNOQRA.";
const NETWORK_MESSAGE = /failed to fetch|networkerror|load failed|network request failed/i;

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof TypeError && NETWORK_MESSAGE.test(error.message);
}

/** Worth one more try: the request may simply not have got through, or the server was busy. */
function isRetryable(error: unknown): boolean {
  if (isNetworkFailure(error)) return true;
  return error instanceof ApiError && (error.status === 429 || error.status >= 500);
}

/** The most characters the server accepts in a file name, counted as UTF-16 units (zod `.max`). */
export const MAX_FILE_NAME_LENGTH = 200;

/** The longest prefix of `text` within `max` UTF-16 units that never splits a surrogate pair. */
function takeUnits(text: string, max: number): string {
  let length = 0;
  let out = '';
  for (const char of text) {
    if (length + char.length > max) break;
    length += char.length;
    out += char;
  }
  return out;
}

/**
 * A file name the server will accept: control characters removed, at most 200 UTF-16 units (the
 * server counts `string.length`, so an emoji is two), never a split surrogate pair, and the
 * extension kept when the name has to be cut. An empty result falls back to "import.csv".
 */
export function normalizeImportFileName(name: string): string {
  const clean = name.replace(/\p{Cc}/gu, '').trim();
  if (clean.length === 0) return 'import.csv';
  if (clean.length <= MAX_FILE_NAME_LENGTH) return clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 ? clean.slice(dot) : '';
  // An absurdly long "extension" is part of the name: cut plainly.
  if (extension.length === 0 || extension.length > 16) {
    return takeUnits(clean, MAX_FILE_NAME_LENGTH);
  }
  return takeUnits(clean.slice(0, dot), MAX_FILE_NAME_LENGTH - extension.length) + extension;
}

/** Where sign-out (and an ended session) sends the user. */
const SIGN_IN_PATH = '/sign-in';

/**
 * Whether leaving a running import should ask first. Not after the run saw its session end, and
 * not on the way to sign-in: sign-out has already ended the session by the time it navigates, so
 * "Keep importing" could not keep importing.
 */
export function shouldBlockImportExit(sessionEnded: boolean, nextPathname: string): boolean {
  return !sessionEnded && nextPathname !== SIGN_IN_PATH;
}

const BAD_FILE_MESSAGE =
  "KNOQRA couldn't accept this file. Check that the columns are mapped and try renaming the file.";

/** Copy for a failed batch. Never shows a browser's raw "Failed to fetch". */
export function describeImportError(error: unknown): string {
  if (isNetworkFailure(error)) return UNREACHABLE;
  // A 400 carries the server's validation wording, which nothing on screen can act on.
  if (error instanceof ApiError && error.status === 400) return BAD_FILE_MESSAGE;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while importing.';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A summary for a run that threw before it could report one, so the wizard never stalls. */
export function failedSummary(error: unknown, total: number): ImportSummary {
  return {
    status: 'failed',
    outcomes: [],
    counts: { created: 0, updated: 0, skipped: 0, rejected: 0 },
    processed: 0,
    total,
    error,
    stoppedAtRow: null,
  };
}

/** The server must answer every row exactly once, with an index that belongs to the batch. */
function assertCompleteAnswer(results: readonly BatchResult[], size: number): void {
  const seen = new Set<number>();
  for (const { index } of results) {
    if (!Number.isInteger(index) || index < 0 || index >= size || seen.has(index)) {
      throw new Error('The server returned an unexpected answer for this batch.');
    }
    seen.add(index);
  }
  if (results.length !== size) {
    throw new Error('The server returned an unexpected answer for this batch.');
  }
}

/**
 * Imports rows in sequential batches of 500. A cancel stops before the next batch; a failed batch
 * stops the run (after one retry for network, 429 and 5xx failures). Either way the results of
 * the batches already imported are kept.
 */
export async function runImport(options: RunImportOptions): Promise<ImportSummary> {
  const { rows, onDuplicate, importBatch, signal, onProgress, rowNumbers } = options;
  const fileName = normalizeImportFileName(options.fileName);
  const wait = options.wait ?? sleep;
  const total = rows.length;
  const batches = Math.ceil(total / BATCH_SIZE);
  const outcomes: RowOutcome[] = [];
  const counts: ImportCounts = { created: 0, updated: 0, skipped: 0, rejected: 0 };
  const rowNumberOf = (index: number): number => rowNumbers?.[index] ?? index + 1;
  const summary = (
    status: ImportSummary['status'],
    stoppedAtIndex: number | null = null,
    error: unknown = null,
  ): ImportSummary => ({
    status,
    outcomes,
    counts,
    processed: outcomes.length,
    total,
    error,
    stoppedAtRow: stoppedAtIndex === null ? null : rowNumberOf(stoppedAtIndex),
  });

  async function send(request: BatchRequest): Promise<BatchResult[]> {
    try {
      return await importBatch(request);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await wait(RETRY_DELAY_MS);
      if (signal?.aborted) throw error;
      return importBatch(request);
    }
  }

  /** "Duplicate of row N" counts rows within a batch; users count rows within the file. */
  function fileLevelMessage(message: string, offset: number): string {
    const match = DUPLICATE_OF_ROW.exec(message);
    if (!match) return message;
    return `Duplicate of row ${rowNumberOf(offset + Number(match[1]) - 1)}`;
  }

  onProgress?.({ batch: 0, batches, processed: 0, total });
  for (let batch = 0; batch < batches; batch += 1) {
    const offset = batch * BATCH_SIZE;
    if (signal?.aborted) return summary('cancelled', offset);
    const slice = rows.slice(offset, offset + BATCH_SIZE);
    let results: BatchResult[];
    try {
      results = await send({ fileName, onDuplicate, rows: slice });
      assertCompleteAnswer(results, slice.length);
    } catch (error) {
      return summary('failed', offset, error);
    }
    for (const result of results) {
      const index = offset + result.index;
      counts[result.status] += 1;
      outcomes.push({
        index,
        rowNumber: rowNumberOf(index),
        status: result.status,
        contactId: result.contactId,
        message: result.error ? fileLevelMessage(result.error.message, offset) : null,
      });
    }
    onProgress?.({ batch: batch + 1, batches, processed: outcomes.length, total });
  }
  return summary('completed');
}

import type { components } from '@knoqra/api-client';
import { toCsv } from './csv';
import { downloadTextFile } from './download';

export type LedgerCsvRow = Pick<
  components['schemas']['UsageLedgerRow'],
  | 'id'
  | 'createdAt'
  | 'kind'
  | 'channel'
  | 'description'
  | 'balanceDeltaMicros'
  | 'heldDeltaMicros'
  | 'balanceAfterMicros'
  | 'heldAfterMicros'
  | 'refType'
  | 'refId'
>;

export interface LedgerFilters {
  from: string;
  to: string;
  channel: 'all' | 'voice' | 'sms' | 'whatsapp' | 'other';
  kind: 'all' | 'credit' | 'adjust' | 'reserve' | 'capture' | 'release';
}

export interface LedgerPage {
  items: LedgerCsvRow[];
  nextCursor: string | null;
}

export type FetchLedgerPage = (
  filters: LedgerFilters,
  cursor: string | undefined,
  limit: number,
  signal?: AbortSignal,
) => Promise<LedgerPage>;

export const EXPORT_PAGE_SIZE = 200;
/** A safety stop for a cursor that never ends: 100,000 rows. */
const MAX_EXPORT_PAGES = 500;

const HEADERS = [
  'Date (UTC)',
  'Kind',
  'Channel',
  'Description',
  'Amount (USD)',
  'Held change (USD)',
  'Balance after (USD)',
  'Held after (USD)',
  'Reference',
  'Entry ID',
] as const;

/**
 * Always six decimals, for the CSV: -20000 -> "-0.020000".
 * A copy of `formatMicrosDecimal` in `@knoqra/core` (packages/core/src/decimal-micros.ts), the
 * source of truth: the web app does not depend on `@knoqra/core`. Keep the two in step.
 */
export function formatMicrosDecimal(micros: number): string {
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError(`micros must be a safe integer, got ${micros}`);
  }
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, '0');
  return `${micros < 0 ? '-' : ''}${whole}.${fraction}`;
}

export function ledgerCsvFilename(from: string, to: string): string {
  return `knoqra-ledger-${from}_${to}.csv`;
}

/** The ledger as CSV text. Every cell goes through `toCsv`, so formulas are guarded. */
export function ledgerCsv(rows: readonly LedgerCsvRow[]): string {
  return toCsv(
    HEADERS,
    rows.map((entry) => [
      entry.createdAt,
      entry.kind,
      entry.channel,
      entry.description,
      formatMicrosDecimal(entry.balanceDeltaMicros),
      formatMicrosDecimal(entry.heldDeltaMicros),
      formatMicrosDecimal(entry.balanceAfterMicros),
      formatMicrosDecimal(entry.heldAfterMicros),
      entry.refType && entry.refId ? `${entry.refType}:${entry.refId}` : '',
      entry.id,
    ]),
  );
}

/** The range holds more rows than one export can carry. */
export class ExportTooLargeError extends Error {
  constructor() {
    super('The ledger export is too large.');
    this.name = 'ExportTooLargeError';
  }
}

/** Pages through every matching row (200 a page), then saves the file. Returns the row count. */
export async function exportLedger(
  filters: LedgerFilters,
  fetchPage: FetchLedgerPage,
  download: (filename: string, text: string) => void = downloadTextFile,
  signal?: AbortSignal,
): Promise<number> {
  const rows: LedgerCsvRow[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
    signal?.throwIfAborted();
    const result = await fetchPage(filters, cursor, EXPORT_PAGE_SIZE, signal);
    rows.push(...result.items);
    if (!result.nextCursor) {
      complete = true;
      break;
    }
    cursor = result.nextCursor;
  }
  // Never save a partial ledger as if it were the whole range.
  if (!complete) throw new ExportTooLargeError();
  signal?.throwIfAborted();
  download(ledgerCsvFilename(filters.from, filters.to), ledgerCsv(rows));
  return rows.length;
}

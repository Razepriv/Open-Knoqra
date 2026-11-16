import { toCsv } from './csv';
import type { RowOutcome } from './import-runner';

/**
 * The rejected rows as a CSV the user can fix and upload again: the original columns, then the
 * row's number in the file and the reason it was rejected.
 */
export function rejectedRowsCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  outcomes: readonly RowOutcome[],
): string {
  const lines = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => {
      const original = rows[outcome.index] ?? [];
      const cells = headers.map((_, column) => original[column] ?? '');
      return [...cells, String(outcome.rowNumber), outcome.message ?? ''];
    });
  return toCsv([...headers, 'Row', 'Reason'], lines);
}

export function rejectedCsvFileName(fileName: string): string {
  return `${fileName.replace(/\.csv$/i, '')}-rejected.csv`;
}

import { describe, expect, it, vi } from 'vitest';
import {
  ExportTooLargeError,
  exportLedger,
  formatMicrosDecimal,
  type LedgerCsvRow,
  ledgerCsv,
  ledgerCsvFilename,
} from './ledger-csv';

const HEADER =
  'Date (UTC),Kind,Channel,Description,Amount (USD),Held change (USD),Balance after (USD),Held after (USD),Reference,Entry ID';

function row(overrides: Partial<LedgerCsvRow> = {}): LedgerCsvRow {
  return {
    id: 'le_1',
    createdAt: '2026-11-12T10:00:00.000Z',
    kind: 'capture',
    channel: 'voice',
    description: 'Call charge',
    balanceDeltaMicros: -20_000,
    heldDeltaMicros: -100_000,
    balanceAfterMicros: 4_980_000,
    heldAfterMicros: 0,
    refType: 'call',
    refId: 'cl_1',
    ...overrides,
  };
}

describe('formatMicrosDecimal', () => {
  it.each([
    [-20_000, '-0.020000'],
    [0, '0.000000'],
    [4_980_000, '4.980000'],
    [1, '0.000001'],
  ])('%i -> %s', (micros, expected) => {
    expect(formatMicrosDecimal(micros)).toBe(expected);
  });
  it('rejects a non-integer', () => {
    expect(() => formatMicrosDecimal(1.5)).toThrow(RangeError);
  });
});

describe('ledgerCsvFilename', () => {
  it('names the file by its range', () => {
    expect(ledgerCsvFilename('2026-11-01', '2026-11-12')).toBe(
      'knoqra-ledger-2026-11-01_2026-11-12.csv',
    );
  });
});

describe('ledgerCsv', () => {
  it('is header-only with no rows', () => {
    expect(ledgerCsv([])).toBe(HEADER);
  });

  it('writes six-decimal amounts, a reference and CRLF endings', () => {
    const csv = ledgerCsv([row(), row({ id: 'le_2' })]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      "2026-11-12T10:00:00.000Z,capture,voice,Call charge,'-0.020000,'-0.100000,4.980000,0.000000,call:cl_1,le_1",
    );
  });

  it('guards a spreadsheet formula in a note', () => {
    const csv = ledgerCsv([
      row({ kind: 'credit', description: '=SUM(A1)', refType: null, refId: null }),
    ]);
    expect(csv).toContain(",'=SUM(A1),");
    expect(csv.split('\r\n')[1]).toContain(',,le_1');
  });

  it('quotes a description with a comma', () => {
    expect(ledgerCsv([row({ description: 'a, b' })])).toContain('"a, b"');
  });
});

describe('exportLedger', () => {
  const filters = { from: '2026-11-01', to: '2026-11-12', channel: 'all', kind: 'all' } as const;

  it('pages through every result at 200 a page, then downloads once', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row({ id: 'le_1' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [row({ id: 'le_2' })], nextCursor: null });
    const download = vi.fn();
    const signal = new AbortController().signal;
    const count = await exportLedger(filters, fetchPage, download, signal);
    expect(count).toBe(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, filters, undefined, 200, signal);
    expect(fetchPage).toHaveBeenNthCalledWith(2, filters, 'c1', 200, signal);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toBe('knoqra-ledger-2026-11-01_2026-11-12.csv');
    expect(download.mock.calls[0]?.[1]).toContain('le_2');
  });

  it('does not download when a page fails', async () => {
    const download = vi.fn();
    await expect(
      exportLedger(filters, vi.fn().mockRejectedValue(new Error('boom')), download),
    ).rejects.toThrow('boom');
    expect(download).not.toHaveBeenCalled();
  });

  it('stops and does not download once aborted', async () => {
    const controller = new AbortController();
    const download = vi.fn();
    const fetchPage = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { items: [row()], nextCursor: 'c1' };
    });
    await expect(exportLedger(filters, fetchPage, download, controller.signal)).rejects.toThrow();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('throws and does not download when the page cap is hit with a cursor left', async () => {
    const download = vi.fn();
    const fetchPage = vi.fn().mockResolvedValue({ items: [], nextCursor: 'more' });
    await expect(exportLedger(filters, fetchPage, download)).rejects.toBeInstanceOf(
      ExportTooLargeError,
    );
    expect(fetchPage).toHaveBeenCalledTimes(500);
    expect(download).not.toHaveBeenCalled();
  });
});

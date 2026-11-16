import { describe, expect, it } from 'vitest';
import type { RowOutcome } from './import-runner';
import { rejectedCsvFileName, rejectedRowsCsv } from './rejected-csv';

const outcome = (
  index: number,
  status: RowOutcome['status'],
  message: string | null,
): RowOutcome => ({
  index,
  rowNumber: index + 2,
  status,
  contactId: null,
  message,
});

describe('rejectedRowsCsv', () => {
  const headers = ['Name', 'Phone'];
  const rows = [['Ada', '+12025550101'], ['Bad', ''], ['Short'], ['Wide', '+123', 'extra']];

  it('lists only rejected rows, with the original cells, their row number and the reason', () => {
    const csv = rejectedRowsCsv(headers, rows, [
      outcome(0, 'created', null),
      outcome(1, 'rejected', 'Phone is required'),
      outcome(2, 'rejected', 'Phone is required'),
      outcome(3, 'skipped', 'Already in your contacts'),
    ]);
    expect(csv).toBe(
      ['Name,Phone,Row,Reason', 'Bad,,3,Phone is required', 'Short,,4,Phone is required'].join(
        '\r\n',
      ),
    );
  });

  it('drops cells beyond the header and guards formula-like cells and reasons', () => {
    const csv = rejectedRowsCsv(headers, rows, [outcome(3, 'rejected', '=bad, really')]);
    expect(csv).toBe(['Name,Phone,Row,Reason', 'Wide,\'+123,5,"\'=bad, really"'].join('\r\n'));
  });

  it('is just the header when nothing was rejected', () => {
    expect(rejectedRowsCsv(headers, rows, [outcome(0, 'created', null)])).toBe(
      'Name,Phone,Row,Reason',
    );
  });
});

describe('rejectedCsvFileName', () => {
  it('swaps the .csv extension for -rejected.csv', () => {
    expect(rejectedCsvFileName('contacts.csv')).toBe('contacts-rejected.csv');
    expect(rejectedCsvFileName('Leads.CSV')).toBe('Leads-rejected.csv');
    expect(rejectedCsvFileName('export')).toBe('export-rejected.csv');
  });
});

describe('rejected rows round trip', () => {
  it('re-imports the same values after export and re-parse', async () => {
    const { guessMapping, parseCsv, toImportRows } = await import('./csv');
    const headers = ['Name', 'Phone', 'Email'];
    const rows = [
      ['Katherine Johnson', '+12025550104', 'not-an-email'],
      ['=Cmd', '-5551234', '@home'],
      ['Comma, Co', '+12025550105', 'a@example.test'],
    ];
    const outcomes = rows.map((_, index) => outcome(index, 'rejected', 'Email is not valid'));
    const exported = `﻿${rejectedRowsCsv(headers, rows, outcomes)}`;
    const parsed = await parseCsv(new File([exported], 'x.csv'));
    const mapping = guessMapping(parsed.headers);
    expect(toImportRows(parsed.rows, mapping)).toEqual([
      { displayName: 'Katherine Johnson', phone: '+12025550104', email: 'not-an-email' },
      { displayName: '=Cmd', phone: '-5551234', email: '@home' },
      { displayName: 'Comma, Co', phone: '+12025550105', email: 'a@example.test' },
    ]);
  });
});

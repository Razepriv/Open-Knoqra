import { describe, expect, it } from 'vitest';
import {
  CsvError,
  guessMapping,
  MAX_CSV_ROWS,
  mappingConflicts,
  parseCsv,
  toImportRows,
} from './csv';

function csvFile(text: string): File {
  return new File([text], 'contacts.csv', { type: 'text/csv' });
}

function bytesFile(bytes: Uint8Array | Buffer): File {
  return new File([new Uint8Array(bytes)], 'contacts.csv', { type: 'text/csv' });
}

const WIN1252_NOTICE =
  "This file isn't UTF-8; we read it as Windows-1252. Check accented names in the preview.";

describe('parseCsv encodings', () => {
  it('reads UTF-8 with accents and raises no warning', async () => {
    const parsed = await parseCsv(csvFile('Name,Phone\nZoë Müller,+12025550101\n'));
    expect(parsed.rows).toEqual([['Zoë Müller', '+12025550101']]);
    expect(parsed.warnings).toEqual([]);
  });

  it('decodes UTF-16 little-endian with a byte order mark', async () => {
    const text = '﻿Name,Phone\nZoë,+12025550101\n';
    const parsed = await parseCsv(bytesFile(Buffer.from(text, 'utf16le')));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rows).toEqual([['Zoë', '+12025550101']]);
    expect(parsed.warnings).toEqual([]);
  });

  it('decodes UTF-16 big-endian with a byte order mark', async () => {
    const text = '﻿Name,Phone\nZoë,+12025550101\n';
    const parsed = await parseCsv(bytesFile(Buffer.from(text, 'utf16le').swap16()));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rows).toEqual([['Zoë', '+12025550101']]);
  });

  it('falls back to Windows-1252 for bytes that are not valid UTF-8, and says so', async () => {
    // 0xEB is "ë" and 0x80 is "€" in Windows-1252; neither is valid UTF-8 on its own.
    const bytes = Buffer.concat([
      Buffer.from('Name,Phone\nZo'),
      Buffer.from([0xeb]),
      Buffer.from(',+12025550101\nPrice'),
      Buffer.from([0x80]),
      Buffer.from(',+12025550102\n'),
    ]);
    const parsed = await parseCsv(bytesFile(bytes));
    expect(parsed.rows).toEqual([
      ['Zoë', '+12025550101'],
      ['Price€', '+12025550102'],
    ]);
    expect(parsed.warnings).toEqual([WIN1252_NOTICE]);
  });
});

describe('parseCsv malformed input', () => {
  it('rejects an unclosed quote with a friendly message', async () => {
    const failure = await parseCsv(
      csvFile('Name,Phone\n"Ada,+12025550101\nGrace,+12025550102\n'),
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(CsvError);
    expect(failure.message).toMatch(/quote/i);
  });

  it('rejects a file whose columns cannot be told apart', async () => {
    const failure = await parseCsv(csvFile('Name\nAda\nGrace\n')).catch((error) => error);
    expect(failure).toBeInstanceOf(CsvError);
    expect(failure.message).toMatch(/columns/i);
  });

  it('reads semicolon-separated files', async () => {
    const parsed = await parseCsv(csvFile('Name;Phone\nAda;+12025550101\n'));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rows).toEqual([['Ada', '+12025550101']]);
  });

  it('warns when the first row looks like a contact instead of column names', async () => {
    const parsed = await parseCsv(csvFile('Ada,+1 202 555 0101\nGrace,+12025550102\n'));
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/first row looks like contact data/i);
    expect(parsed.headers).toEqual(['Ada', '+1 202 555 0101']);
  });

  it('warns when a header cell is an email address', async () => {
    const parsed = await parseCsv(csvFile('Ada,ada@example.test\nGrace,grace@example.test\n'));
    expect(parsed.warnings[0]).toMatch(/first row looks like contact data/i);
  });

  it('does not warn about ordinary headers', async () => {
    const parsed = await parseCsv(csvFile('Name,Phone,Phone 2\nAda,+12025550101,\n'));
    expect(parsed.warnings).toEqual([]);
  });
});

describe('parseCsv row numbers', () => {
  it('numbers rows like a spreadsheet: blank lines count, quoted line breaks do not', async () => {
    const text = 'Name,Phone\n\nAda,1\n"Multi\nline",2\n\n\nGrace,3\n';
    const parsed = await parseCsv(csvFile(text));
    expect(parsed.rows.map((row) => row[0])).toEqual(['Ada', 'Multi\nline', 'Grace']);
    expect(parsed.rowNumbers).toEqual([3, 4, 7]);
  });

  it('numbers plain rows from 2 when the header is on row 1', async () => {
    const parsed = await parseCsv(csvFile('Name,Phone\nA,1\nB,2\n'));
    expect(parsed.rowNumbers).toEqual([2, 3]);
  });

  it('counts the header where it really is when blank lines come first', async () => {
    const parsed = await parseCsv(csvFile('\n\nName,Phone\nA,1\n'));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rowNumbers).toEqual([4]);
  });

  it('does not count blank lines against the row limit', async () => {
    const blanks = '\n'.repeat(MAX_CSV_ROWS + 50);
    const parsed = await parseCsv(csvFile(`Name,Phone\n${blanks}A,1\n`));
    expect(parsed.rows).toEqual([['A', '1']]);
  });
});

describe('guessMapping names', () => {
  it('joins First Name and Last Name columns', () => {
    expect(guessMapping(['First Name', 'Last Name', 'Mobile'])).toEqual({
      displayName: 0,
      lastName: 1,
      phone: 2,
    });
  });

  it('prefers a full-name column over the parts', () => {
    expect(guessMapping(['First name', 'Last name', 'Full name', 'Phone'])).toEqual({
      displayName: 2,
      phone: 3,
    });
  });

  it('uses a lone first or last name column as the name', () => {
    expect(guessMapping(['Surname', 'Phone'])).toEqual({ displayName: 0, phone: 1 });
    expect(guessMapping(['Given name', 'Phone'])).toEqual({ displayName: 0, phone: 1 });
  });
});

describe('toImportRows names and quotes', () => {
  it('joins first and last name with a space and skips a blank part', () => {
    const mapping = { displayName: 0, lastName: 1, phone: 2 };
    expect(
      toImportRows(
        [
          ['Ada', 'Lovelace', '+12025550101'],
          ['Cher', '', '+12025550102'],
          ['', 'Madonna', '+12025550103'],
        ],
        mapping,
      ).map((row) => row.displayName),
    ).toEqual(['Ada Lovelace', 'Cher', 'Madonna']);
  });

  it.each([
    ["'+12025550104", '+12025550104'],
    ["'=SUM(A1)", '=SUM(A1)'],
    ["'-5", '-5'],
    ["'@handle", '@handle'],
  ])('removes the export guard from %j', (cell, expected) => {
    expect(toImportRows([['Ada', cell]], { displayName: 0, phone: 1 })[0]?.phone).toBe(expected);
  });

  it.each([["'quoted"], ["''+1"], ["'"], ["rock 'n' roll"]])(
    'leaves %j alone because no formula character follows the quote',
    (cell) => {
      expect(toImportRows([[cell]], { displayName: 0 })[0]?.displayName).toBe(cell);
    },
  );

  it('removes only one guard quote', () => {
    expect(toImportRows([["''+1"]], { displayName: 0 })[0]?.displayName).toBe("''+1");
  });
});

describe('mappingConflicts', () => {
  it('reports columns that feed more than one field', () => {
    expect(mappingConflicts({ displayName: 0, phone: 1, company: 0, email: 1 })).toEqual([
      { column: 0, fields: ['displayName', 'company'] },
      { column: 1, fields: ['phone', 'email'] },
    ]);
  });

  it('is empty when every column is used once', () => {
    expect(mappingConflicts({ displayName: 0, lastName: 1, phone: 2 })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CsvError,
  escapeCsvCell,
  guessMapping,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  parseCsv,
  toCsv,
  toImportRows,
} from './csv';

function csvFile(text: string, name = 'contacts.csv'): File {
  return new File([text], name, { type: 'text/csv' });
}

describe('parseCsv', () => {
  it('splits headers from rows and skips empty lines', async () => {
    const parsed = await parseCsv(csvFile('Name,Phone\nAda,+12025550101\n\nGrace,+12025550102\n'));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
    expect(parsed.rows).toEqual([
      ['Ada', '+12025550101'],
      ['Grace', '+12025550102'],
    ]);
  });

  it('strips a UTF-8 byte order mark from the first header', async () => {
    const parsed = await parseCsv(csvFile('﻿Name,Phone\nAda,+12025550101\n'));
    expect(parsed.headers).toEqual(['Name', 'Phone']);
  });

  it('handles quoted cells with commas, quotes and newlines', async () => {
    const parsed = await parseCsv(
      csvFile('Name,Company\n"Lovelace, Ada","Analytical ""Engines""\nLtd"\n'),
    );
    expect(parsed.rows).toEqual([['Lovelace, Ada', 'Analytical "Engines"\nLtd']]);
  });

  it('rejects a file with more than 20,000 data rows', async () => {
    const body = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `n${i},+1202555${i}`).join(
      '\n',
    );
    await expect(parseCsv(csvFile(`Name,Phone\n${body}`))).rejects.toThrow(CsvError);
    await expect(parseCsv(csvFile(`Name,Phone\n${body}`))).rejects.toThrow(/20,000/);
  });

  it('accepts exactly 20,000 data rows', async () => {
    const body = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `n${i},x`).join('\n');
    const parsed = await parseCsv(csvFile(`Name,Phone\n${body}`));
    expect(parsed.rows).toHaveLength(MAX_CSV_ROWS);
  });

  it('rejects a file over 10 MB before reading it', async () => {
    const big = new File([new Uint8Array(MAX_CSV_BYTES + 1)], 'big.csv');
    await expect(parseCsv(big)).rejects.toThrow(/10 MB/);
  });

  it('rejects a file with no data rows', async () => {
    await expect(parseCsv(csvFile('Name,Phone\n'))).rejects.toThrow(/no contacts/i);
    await expect(parseCsv(csvFile(''))).rejects.toThrow(CsvError);
  });
});

describe('guessMapping', () => {
  it('maps common header names case-insensitively', () => {
    const headers = ['Full Name', 'Mobile', 'Organization', 'E-mail', 'Job Title', 'TZ', 'Labels'];
    expect(guessMapping(headers)).toEqual({
      displayName: 0,
      phone: 1,
      company: 2,
      email: 3,
      jobTitle: 4,
      timezone: 5,
      tags: 6,
    });
  });

  it('maps the plain header set', () => {
    expect(
      guessMapping(['name', 'phone', 'company', 'email', 'title', 'timezone', 'tags']),
    ).toEqual({
      displayName: 0,
      phone: 1,
      company: 2,
      email: 3,
      jobTitle: 4,
      timezone: 5,
      tags: 6,
    });
  });

  it('ignores padding, case and punctuation in headers', () => {
    expect(guessMapping(['  CONTACT ', 'Phone_Number', 'Time zone'])).toEqual({
      displayName: 0,
      phone: 1,
      timezone: 2,
    });
  });

  it('leaves unknown headers unmapped and uses each column once', () => {
    expect(guessMapping(['id', 'name', 'Name', 'notes'])).toEqual({ displayName: 1 });
  });

  it('returns an empty mapping when nothing matches', () => {
    expect(guessMapping(['a', 'b'])).toEqual({});
  });
});

describe('toImportRows', () => {
  const mapping = { displayName: 0, phone: 1, company: 2, tags: 3 } as const;

  it('builds one row per input row and keeps their order', () => {
    const rows = toImportRows(
      [
        ['Ada', '+12025550101', 'Engines', 'vip, early;press'],
        ['Grace', '+12025550102', '', ''],
      ],
      mapping,
    );
    expect(rows).toEqual([
      {
        displayName: 'Ada',
        phone: '+12025550101',
        company: 'Engines',
        tags: ['vip', 'early', 'press'],
      },
      { displayName: 'Grace', phone: '+12025550102' },
    ]);
  });

  it('trims cells and drops blank ones, including short rows', () => {
    const rows = toImportRows([['  Ada  ', '   ']], mapping);
    expect(rows).toEqual([{ displayName: 'Ada' }]);
  });

  it('drops empty tag items', () => {
    const rows = toImportRows([['Ada', '+12025550101', '', ' , ;a;; b ,']], mapping);
    expect(rows[0]?.tags).toEqual(['a', 'b']);
  });

  it('omits unmapped fields entirely', () => {
    expect(toImportRows([['Ada', '+12025550101', 'X', 't']], { displayName: 0 })).toEqual([
      { displayName: 'Ada' },
    ]);
  });
});

describe('escapeCsvCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+15550100', "'+15550100"],
    ['-5', "'-5"],
    ['@x', "'@x"],
    ['\tx', "'\tx"],
  ])('guards the formula prefix of %j', (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it('guards a leading carriage return and then quotes it', () => {
    expect(escapeCsvCell('\rx')).toBe('"\'\rx"');
  });

  it('leaves plain text alone', () => {
    expect(escapeCsvCell('Ada Lovelace')).toBe('Ada Lovelace');
    expect(escapeCsvCell('a=b')).toBe('a=b');
    expect(escapeCsvCell('')).toBe('');
  });

  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
  });

  it('applies the guard before quoting', () => {
    expect(escapeCsvCell('=SUM(A1,A2)')).toBe('"\'=SUM(A1,A2)"');
  });
});

describe('toCsv', () => {
  it('joins escaped cells with CRLF line endings', () => {
    expect(
      toCsv(
        ['Name', 'Reason'],
        [
          ['Ada, L.', '=bad'],
          ['Grace', 'ok'],
        ],
      ),
    ).toBe('Name,Reason\r\n"Ada, L.",\'=bad\r\nGrace,ok');
  });

  it('writes just the header for no rows', () => {
    expect(toCsv(['A', 'B'], [])).toBe('A,B');
  });
});

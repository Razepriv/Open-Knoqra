import type { components } from '@knoqra/api-client';
import Papa from 'papaparse';

export type ImportRow = components['schemas']['ImportRow'];

/** The fields an imported contact can carry. */
export const CONTACT_FIELDS = [
  'displayName',
  'phone',
  'company',
  'email',
  'jobTitle',
  'timezone',
  'tags',
] as const;

export type ContactField = (typeof CONTACT_FIELDS)[number];

/** Fields a column can be assigned to: the contact fields, plus a last name joined onto the name. */
export const MAPPING_FIELDS = [
  'displayName',
  'lastName',
  'phone',
  'company',
  'email',
  'jobTitle',
  'timezone',
  'tags',
] as const;

export type MappingField = (typeof MAPPING_FIELDS)[number];
export type ColumnMapping = Partial<Record<MappingField, number>>;

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_ROWS = 20_000;

export interface ParsedCsv {
  headers: string[];
  /** Non-empty data rows, in file order. */
  rows: string[][];
  /**
   * Each data row's number as a spreadsheet shows it: the header's row is counted, blank lines
   * count as rows, and a line break inside a quoted cell does not. Parallel to `rows`.
   */
  rowNumbers: number[];
  /** Things worth a second look that do not stop the import. */
  warnings: string[];
}

/** A problem with the chosen file that the user can act on. The message is safe to show. */
export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvError';
  }
}

const BOM = '﻿';
const WINDOWS_1252_NOTICE =
  "This file isn't UTF-8; we read it as Windows-1252. Check accented names in the preview.";

// Windows-1252 bytes 0x80-0x9F. Browsers decode these as the characters below; some runtimes
// (ICU-based decoders) return C1 control characters instead, so map them explicitly.
const WINDOWS_1252_HIGH: Readonly<Record<string, string>> = {
  '': '€',
  '': '‚',
  '': 'ƒ',
  '': '„',
  '': '…',
  '': '†',
  '': '‡',
  '': 'ˆ',
  '': '‰',
  '': 'Š',
  '': '‹',
  '': 'Œ',
  '': 'Ž',
  '': '‘',
  '': '’',
  '': '“',
  '': '”',
  '': '•',
  '': '–',
  '': '—',
  '': '˜',
  '': '™',
  '': 'š',
  '': '›',
  '': 'œ',
  '': 'ž',
  '': 'Ÿ',
};

function decodeWindows1252(buffer: ArrayBuffer): string {
  const text = new TextDecoder('windows-1252').decode(buffer);
  return text.replace(/[-]/g, (char) => WINDOWS_1252_HIGH[char] ?? char);
}

/** UTF-16 by byte order mark, then strict UTF-8, then Windows-1252 (with a notice). */
function decodeText(buffer: ArrayBuffer): { text: string; warnings: string[] } {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer), warnings: [] };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer), warnings: [] };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.startsWith(BOM) ? text.slice(BOM.length) : text, warnings: [] };
  } catch {
    return {
      text: decodeWindows1252(buffer),
      warnings: [WINDOWS_1252_NOTICE],
    };
  }
}

const PHONE_LIKE = /^\+?[\d\s().-]+$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeData(cell: string): boolean {
  const value = cell.trim();
  if (EMAIL_LIKE.test(value)) return true;
  return PHONE_LIKE.test(value) && value.replace(/\D/g, '').length >= 7;
}

const HEADER_LOOKS_LIKE_DATA =
  'The first row looks like contact data, not column names. KNOQRA treats the first row as the header, ' +
  'so that contact will not be imported. If this file has no header row, add one and upload it again.';

function isBlank(record: readonly string[]): boolean {
  return record.every((value) => value.trim() === '');
}

/** The first problem that makes the parse untrustworthy, as friendly copy. */
function fatalParseError(errors: readonly Papa.ParseError[]): string | null {
  const quotes = errors.find((e) => e.code === 'MissingQuotes' || e.code === 'InvalidQuotes');
  if (quotes) {
    const where = quotes.row === undefined ? '' : ` near row ${quotes.row + 1}`;
    return `A quoted value${where} is not closed properly, so the rows after it cannot be read. Check the quotation marks in your file and try again.`;
  }
  return null;
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Picks the column separator from the header line, ignoring quoted text. Papa's own detection
 * misjudges short files (a trailing newline counts as a one-column row), so we choose it.
 */
function detectDelimiter(text: string): string | null {
  const headerLine = text.split(/\r\n|\n|\r/).find((line) => line.trim() !== '') ?? '';
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const char of headerLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && counts.has(char)) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

const DELIMITER_ERROR =
  "We couldn't tell where one column ends and the next begins. Save the file as a CSV with commas or semicolons between columns, with a header row and at least a name and a phone column.";

/**
 * Reads a CSV file in the browser. Rejects with a CsvError for a file that is too big, empty or
 * malformed. Other findings come back as `warnings`.
 */
export async function parseCsv(file: File): Promise<ParsedCsv> {
  if (file.size > MAX_CSV_BYTES) {
    throw new CsvError(
      'This file is larger than 10 MB. Split it into smaller files and try again.',
    );
  }
  const { text, warnings } = decodeText(await file.arrayBuffer());
  const delimiter = detectDelimiter(text);
  if (delimiter === null) {
    throw new CsvError(
      text.trim() === ''
        ? 'This file has no contacts in it. Add a header row and at least one row.'
        : DELIMITER_ERROR,
    );
  }
  const result = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter });

  const fatal = fatalParseError(result.errors);
  if (fatal) throw new CsvError(fatal);

  const records = result.data;
  const headerIndex = records.findIndex((record) => !isBlank(record));
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  records.forEach((record, index) => {
    if (index <= headerIndex || isBlank(record)) return;
    rows.push(record);
    rowNumbers.push(index + 1);
  });

  const headerRecord = records[headerIndex];
  if (!headerRecord || rows.length === 0) {
    throw new CsvError('This file has no contacts in it. Add a header row and at least one row.');
  }
  if (rows.length > MAX_CSV_ROWS) {
    throw new CsvError(
      `This file has more than ${MAX_CSV_ROWS.toLocaleString('en-US')} rows. Split it into smaller files and try again.`,
    );
  }
  const headers = headerRecord.map((header) => header.trim());
  const allWarnings = headers.some(looksLikeData)
    ? [...warnings, HEADER_LOOKS_LIKE_DATA]
    : warnings;
  return { headers, rows, rowNumbers, warnings: allWarnings };
}

const SYNONYMS: Record<ContactField, readonly string[]> = {
  displayName: ['name', 'full name', 'fullname', 'display name', 'contact', 'contact name'],
  phone: [
    'phone',
    'phone number',
    'mobile',
    'mobile phone',
    'mobile number',
    'cell',
    'number',
    'tel',
    'telephone',
  ],
  company: ['company', 'company name', 'organization', 'organisation', 'employer'],
  email: ['email', 'e mail', 'email address'],
  jobTitle: ['title', 'job title', 'role', 'position'],
  timezone: ['timezone', 'time zone', 'tz'],
  tags: ['tags', 'labels'],
};

const FIRST_NAME = ['first name', 'firstname', 'given name', 'forename'];
const LAST_NAME = ['last name', 'lastname', 'surname', 'family name'];

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Suggests which column holds each contact field. Each column is used for at most one field.
 * Without a full-name column, First Name and Last Name columns are joined into the name.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const taken = new Set<number>();
  const find = (names: readonly string[]) =>
    normalized.findIndex((header, i) => !taken.has(i) && names.includes(header));
  const mapping: ColumnMapping = {};
  for (const field of CONTACT_FIELDS) {
    const index = find(SYNONYMS[field]);
    if (index === -1) continue;
    mapping[field] = index;
    taken.add(index);
  }
  if (mapping.displayName === undefined) {
    const first = find(FIRST_NAME);
    if (first !== -1) taken.add(first);
    const last = find(LAST_NAME);
    if (first !== -1) mapping.displayName = first;
    if (last !== -1) {
      if (first === -1) mapping.displayName = last;
      else mapping.lastName = last;
    }
  }
  return mapping;
}

/** Columns that feed more than one field, which is allowed but usually a slip. */
export function mappingConflicts(
  mapping: ColumnMapping,
): { column: number; fields: MappingField[] }[] {
  const byColumn = new Map<number, MappingField[]>();
  for (const field of MAPPING_FIELDS) {
    const column = mapping[field];
    if (column === undefined) continue;
    byColumn.set(column, [...(byColumn.get(column) ?? []), field]);
  }
  return [...byColumn.entries()]
    .filter(([, fields]) => fields.length > 1)
    .sort(([a], [b]) => a - b)
    .map(([column, fields]) => ({ column, fields }));
}

const EXPORT_GUARD = /^'[=+\-@\t\r]/;

/** One trimmed cell. A leading `'` that our own export put before a formula character is removed. */
function cell(row: readonly string[], index: number | undefined): string {
  const raw = index === undefined ? '' : (row[index] ?? '');
  return (EXPORT_GUARD.test(raw) ? raw.slice(1) : raw).trim();
}

function splitTags(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** One import row per input row, in the same order. Blank cells and unmapped fields are omitted. */
export function toImportRows(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
): ImportRow[] {
  return rows.map((row) => {
    const out: ImportRow = {};
    const displayName = [cell(row, mapping.displayName), cell(row, mapping.lastName)]
      .filter((part) => part !== '')
      .join(' ');
    if (displayName) out.displayName = displayName;
    const phone = cell(row, mapping.phone);
    if (phone) out.phone = phone;
    const company = cell(row, mapping.company);
    if (company) out.company = company;
    const email = cell(row, mapping.email);
    if (email) out.email = email;
    const jobTitle = cell(row, mapping.jobTitle);
    if (jobTitle) out.jobTitle = jobTitle;
    const timezone = cell(row, mapping.timezone);
    if (timezone) out.timezone = timezone;
    const tags = splitTags(cell(row, mapping.tags));
    if (tags.length > 0) out.tags = tags;
    return out;
  });
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Makes one value safe to write into a CSV that a spreadsheet will open: a leading `=`, `+`, `-`,
 * `@`, tab or CR gets a `'` in front so it is read as text, then RFC 4180 quoting is applied.
 */
export function escapeCsvCell(value: string): string {
  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Joins a header row and data rows into CSV text with CRLF line endings. */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, ...rows].map((line) => line.map(escapeCsvCell).join(',')).join('\r\n');
}

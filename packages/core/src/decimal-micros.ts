const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/** Parses "300.00" / "-1.5" into integer micros by string splitting (no float math). */
export function parseDecimalMicros(input: string): number | null {
  const match = DECIMAL_PATTERN.exec(input);
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  const micros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(micros)) return null;
  return sign === '-' && micros !== 0 ? -micros : micros;
}

/** Always six decimals, for CSV: -20000 -> "-0.020000". */
export function formatMicrosDecimal(micros: number): string {
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError(`micros must be a safe integer, got ${micros}`);
  }
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, '0');
  return `${micros < 0 ? '-' : ''}${whole}.${fraction}`;
}

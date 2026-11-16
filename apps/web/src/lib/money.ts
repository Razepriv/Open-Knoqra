const MICROS_PER_DOLLAR = 1_000_000;
const MICROS_PER_CENT = 10_000;
const MAX_FRACTION_DIGITS = 6;
const MONEY_INPUT = /^\$?(\d*)(?:\.(\d*))?$/;

/**
 * Integer micros as dollars: two decimals, and up to six only when the micros below a cent are
 * not zero (`$0.10`, `$4.98`, `$0.005`). Integer math only; a negative gets a leading minus.
 */
export function formatMicros(micros: number): string {
  const whole = Number.isFinite(micros) ? Math.trunc(micros) : 0;
  const abs = Math.abs(whole);
  const dollars = (abs - (abs % MICROS_PER_DOLLAR)) / MICROS_PER_DOLLAR;
  const rest = abs % MICROS_PER_DOLLAR;
  const sign = whole < 0 ? '-' : '';
  const fraction =
    rest % MICROS_PER_CENT === 0
      ? String(rest / MICROS_PER_CENT).padStart(2, '0')
      : String(rest).padStart(MAX_FRACTION_DIGITS, '0').replace(/0+$/, '').padEnd(3, '0');
  return `${sign}$${dollars}.${fraction}`;
}

/**
 * Parses a dollar amount such as `5`, `$5.25` or `0.1` into integer micros by splitting the string,
 * with no float math. Null for anything else: negatives, more than six fraction digits, junk.
 */
export function dollarsToMicros(input: string): number | null {
  const match = MONEY_INPUT.exec(input.trim());
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (whole === '' && fraction === '') return null;
  if (fraction.length > MAX_FRACTION_DIGITS) return null;
  const micros =
    Number(whole === '' ? '0' : whole) * MICROS_PER_DOLLAR +
    Number(fraction.padEnd(MAX_FRACTION_DIGITS, '0'));
  return Number.isSafeInteger(micros) && micros <= 9_000_000_000_000_000 ? micros : null;
}

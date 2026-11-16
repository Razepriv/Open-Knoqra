/**
 * KNOQRA does not provide emergency calling: its users may be outside the US, where a US 911
 * centre cannot locate them, and numbers carry no registered E911 address. Emergency and special
 * short codes are refused before a call is authorized, with this message.
 */
export const EMERGENCY_CALL_MESSAGE =
  "KNOQRA can't place emergency calls. Use a mobile or landline phone: dial 112 in India or 911 in the US.";

/** US 911 and test 933, the 988 crisis line, India and international emergency numbers. */
const EMERGENCY_CODES: ReadonlySet<string> = new Set([
  '911',
  '933',
  '988',
  '112',
  '999',
  '000',
  '100',
  '101',
  '102',
  '108',
]);

/** US N11 service codes (211 to 811); 911 is listed above. */
const N11 = /^[2-9]11$/;

const DIALABLE = /^[\s\d+()\-.]*$/;

/**
 * Whether a typed destination is an emergency or special short code, with or without a +1 or +91
 * prefix. Never throws; a non-string is not an emergency number.
 */
export function isEmergencyNumber(input: string): boolean {
  if (typeof input !== 'string' || !DIALABLE.test(input)) return false;
  let digits = input.replace(/\D/g, '');
  if (digits.length === 4 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 5 && digits.startsWith('91')) digits = digits.slice(2);
  return EMERGENCY_CODES.has(digits) || N11.test(digits);
}

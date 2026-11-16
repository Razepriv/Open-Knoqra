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

/** `sip:911@host;user=phone`, `sips:+1911@host` or `tel:911`: the dialed part of a provider URI. */
const URI = /^(?:sips?|tel):([^@;]*)/i;

/**
 * The emergency or special short code a destination dials ('911', '112' and so on), or null.
 * Accepts what a person types (with or without a +1 or +91 prefix) and what a provider reports for
 * a call's destination, which can be a SIP or tel URI. Never throws; a non-string is not one.
 */
export function emergencyCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const dialed = URI.exec(input.trim())?.[1] ?? input;
  if (!DIALABLE.test(dialed)) return null;
  let digits = dialed.replace(/\D/g, '');
  if (digits.length === 4 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 5 && digits.startsWith('91')) digits = digits.slice(2);
  return EMERGENCY_CODES.has(digits) || N11.test(digits) ? digits : null;
}

/**
 * Whether a typed destination is an emergency or special short code, with or without a +1 or +91
 * prefix. Never throws; a non-string is not an emergency number.
 */
export function isEmergencyNumber(input: string): boolean {
  return emergencyCode(input) !== null;
}

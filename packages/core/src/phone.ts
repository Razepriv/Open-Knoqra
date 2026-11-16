import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { err, ok, type Result } from './result';

/** Normalizes free-form input to E.164, or returns `invalid_phone`. Never throws. */
export function normalizePhone(
  input: string,
  defaultCountry: 'US' = 'US',
): Result<string, 'invalid_phone'> {
  if (typeof input !== 'string') return err('invalid_phone');
  try {
    const parsed = parsePhoneNumberFromString(input, defaultCountry);
    if (!parsed?.isValid()) return err('invalid_phone');
    return ok(parsed.number);
  } catch {
    return err('invalid_phone');
  }
}

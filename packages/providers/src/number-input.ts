import type { NumberSearch } from './types';

const AREA_CODE = /^[2-9]\d{2}$/;
const REGION = /^[A-Z]{2}$/;
const US_E164 = /^\+1[2-9]\d{9}$/;
const CONTROL_CHARS = /\p{Cc}/u;
const MAX_LOCALITY = 60;
export const MAX_SEARCH_LIMIT = 20;

/** Defense in depth: the API validates first, so a failure here is a programming error. */
export function validateSearch(q: NumberSearch): void {
  if (q.areaCode !== undefined && !AREA_CODE.test(q.areaCode)) {
    throw new RangeError('invalid_search');
  }
  if (q.region !== undefined && !REGION.test(q.region)) throw new RangeError('invalid_search');
  if (q.locality !== undefined) {
    const trimmed = q.locality.trim();
    if (
      trimmed !== q.locality ||
      trimmed.length < 1 ||
      trimmed.length > MAX_LOCALITY ||
      CONTROL_CHARS.test(trimmed)
    ) {
      throw new RangeError('invalid_search');
    }
  }
}

/** An integer in [1, 20]; a missing or NaN limit falls back to 20. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return MAX_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

export function assertUsE164(e164: string): void {
  if (!US_E164.test(e164)) throw new RangeError('invalid_number');
}

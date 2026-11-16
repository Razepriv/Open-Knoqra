import { canonicalTimeZone, err, isValidTimeZone, ok, type Result } from '@knoqra/core';

export const DEFAULT_TIME_ZONE = 'UTC';
export const MAX_TIME_ZONE_LENGTH = 64;

/**
 * The `?tz=` query value: absent means UTC; anything that is not an IANA zone is refused. Legacy
 * aliases come back under their current name, which is the one Postgres is sure to know.
 */
export function parseTimeZoneQuery(value: string | undefined): Result<string, 'invalid_time_zone'> {
  if (value === undefined || value === '') return ok(DEFAULT_TIME_ZONE);
  if (value.length > MAX_TIME_ZONE_LENGTH || !isValidTimeZone(value)) {
    return err('invalid_time_zone');
  }
  return ok(canonicalTimeZone(value));
}

/** Postgres raises invalid_parameter_value (22023) for a zone its own database does not know. */
export function isPostgresInvalidZone(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ((current as { code?: unknown }).code === '22023') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

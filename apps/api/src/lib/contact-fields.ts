export const CONTACT_UNIQUE_PHONE = 'contact_organization_id_phone_e164_unique';
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors; walks the `cause` chain for a pg unique violation. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pg = e as Error & { code?: unknown; constraint?: unknown };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint === constraint) return true;
  }
  return false;
}

/** Blank text means "no value"; undefined (field absent) stays undefined. */
export function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value.trim() === '' ? null : value;
}

/** Trims, drops empties and removes duplicates, keeping first-seen order. */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

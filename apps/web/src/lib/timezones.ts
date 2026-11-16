const FALLBACK_ZONES: readonly string[] = [
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Berlin',
  'Europe/Lisbon',
  'Europe/London',
];

function runtimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return FALLBACK_ZONES; // Older engines without Intl.supportedValuesOf.
  }
}

/** The browser's own zone, when it reports a usable IANA name. */
export function browserTimeZone(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * IANA zones for the picker, sorted. UTC is added because engines omit it from the list, and a
 * saved zone this runtime does not list stays selectable so opening Settings never silently
 * changes it.
 */
export function timeZoneOptions(saved: string | null): string[] {
  const zones = new Set<string>([...runtimeZones(), 'UTC']);
  if (saved) zones.add(saved);
  return [...zones].sort();
}

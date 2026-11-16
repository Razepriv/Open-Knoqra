/** Numeric UTC offsets ("+05:00") are valid for Intl but are not IANA zone names. */
const OFFSET_LIKE = /^[+-]?\d/;

/** True when `value` is an IANA time zone the runtime knows (DateTimeFormat round-trip). */
export function isValidTimeZone(value: string): boolean {
  if (value.length === 0 || OFFSET_LIKE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Legacy aliases that browsers still report (ICU keeps the old names: Chromium says
 * "Asia/Calcutta") mapped to their current IANA names. A Postgres built without the tz "backward"
 * links rejects the old names in `AT TIME ZONE`.
 */
const LEGACY_TIME_ZONES: ReadonlyMap<string, string> = new Map([
  ['Africa/Asmera', 'Africa/Asmara'],
  ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ['America/Catamarca', 'America/Argentina/Catamarca'],
  ['America/Coral_Harbour', 'America/Atikokan'],
  ['America/Cordoba', 'America/Argentina/Cordoba'],
  ['America/Godthab', 'America/Nuuk'],
  ['America/Indianapolis', 'America/Indiana/Indianapolis'],
  ['America/Jujuy', 'America/Argentina/Jujuy'],
  ['America/Louisville', 'America/Kentucky/Louisville'],
  ['America/Mendoza', 'America/Argentina/Mendoza'],
  ['Asia/Calcutta', 'Asia/Kolkata'],
  ['Asia/Katmandu', 'Asia/Kathmandu'],
  ['Asia/Rangoon', 'Asia/Yangon'],
  ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
  ['Atlantic/Faeroe', 'Atlantic/Faroe'],
  ['Europe/Kiev', 'Europe/Kyiv'],
  ['Pacific/Enderbury', 'Pacific/Kanton'],
  ['Pacific/Ponape', 'Pacific/Pohnpei'],
  ['Pacific/Truk', 'Pacific/Chuuk'],
]);

/** The current IANA name for a legacy alias; any other value is returned unchanged. */
export function canonicalTimeZone(zone: string): string {
  return LEGACY_TIME_ZONES.get(zone) ?? zone;
}

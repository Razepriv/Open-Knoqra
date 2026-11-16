export interface DeviceDescription {
  browser: string | null;
  os: string | null;
  /** "Chrome on Windows", or whichever half is known, or "Unknown device". */
  label: string;
}

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['Edge', /\bEdg(?:e|A|iOS)?\//],
  ['Opera', /\bOPR\//],
  ['Firefox', /\b(?:Firefox|FxiOS)\//],
  ['Chrome', /\b(?:Chrome|CriOS)\//],
  ['Safari', /\bSafari\//],
];

// iOS and Android user agents also mention Mac OS X and Linux, so they come first.
const SYSTEMS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['Android', /\bAndroid\b/],
  ['Windows', /\bWindows\b/],
  ['macOS', /\bMacintosh\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['Linux', /\bLinux\b/],
];

function firstMatch(
  userAgent: string,
  table: ReadonlyArray<readonly [name: string, pattern: RegExp]>,
): string | null {
  for (const [name, pattern] of table) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}

/** A short, human label for the device behind a session, read from its user agent. */
export function describeDevice(userAgent: string | null | undefined): DeviceDescription {
  const agent = userAgent ?? '';
  const browser = firstMatch(agent, BROWSERS);
  const os = firstMatch(agent, SYSTEMS);
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'Unknown device');
  return { browser, os, label };
}

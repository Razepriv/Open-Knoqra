/** True on Apple platforms, where shortcuts use ⌘ instead of Ctrl. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** How to write the palette shortcut for this platform: "⌘K" on Apple devices, else "Ctrl K". */
export function commandKeyLabel(platform: string): string {
  return isApplePlatform(platform) ? '⌘K' : 'Ctrl K';
}

interface NavigatorWithUAData {
  userAgentData?: { platform?: string };
}

/** The browser's platform name ("macOS", "Windows", "MacIntel"), or '' outside a browser. */
export function browserPlatform(): string {
  if (typeof navigator === 'undefined') return '';
  const uaData = (navigator as Navigator & NavigatorWithUAData).userAgentData;
  return uaData?.platform || navigator.platform || '';
}

import { describe, expect, it } from 'vitest';
import { commandKeyLabel, isApplePlatform } from './platform';

describe('platform shortcuts', () => {
  it.each(['macOS', 'MacIntel', 'iPhone', 'iPad'])('uses ⌘ on %s', (platform) => {
    expect(isApplePlatform(platform)).toBe(true);
    expect(commandKeyLabel(platform)).toBe('⌘K');
  });

  it.each(['Windows', 'Win32', 'Linux x86_64', 'Android', ''])('uses Ctrl on %j', (platform) => {
    expect(isApplePlatform(platform)).toBe(false);
    expect(commandKeyLabel(platform)).toBe('Ctrl K');
  });
});

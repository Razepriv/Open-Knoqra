import { describe, expect, it } from 'vitest';
import { describeDevice } from './user-agent';

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const EDGE_WIN = `${CHROME_WIN} Edg/131.0.0.0`;
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

describe('describeDevice', () => {
  it.each([
    [CHROME_WIN, 'Chrome', 'Windows'],
    [EDGE_WIN, 'Edge', 'Windows'],
    [SAFARI_MAC, 'Safari', 'macOS'],
    [FIREFOX_LINUX, 'Firefox', 'Linux'],
    [SAFARI_IPHONE, 'Safari', 'iOS'],
    [CHROME_ANDROID, 'Chrome', 'Android'],
  ])('reads browser and system from %#', (ua, browser, os) => {
    expect(describeDevice(ua)).toEqual({ browser, os, label: `${browser} on ${os}` });
  });

  it('falls back to an unknown device for a missing or odd user agent', () => {
    expect(describeDevice(null).label).toBe('Unknown device');
    expect(describeDevice('').label).toBe('Unknown device');
    expect(describeDevice('curl/8.0').label).toBe('Unknown device');
  });

  it('names a recognised browser even when the system is unknown', () => {
    expect(describeDevice('Foo Firefox/120.0').label).toBe('Firefox');
  });
});

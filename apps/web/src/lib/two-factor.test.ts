import { describe, expect, it } from 'vitest';
import {
  backupCodesFile,
  groupSecret,
  needsTwoFactor,
  normalizeCode,
  secretFromUri,
} from './two-factor';

describe('secretFromUri', () => {
  it('reads the shared secret from an otpauth URI', () => {
    expect(
      secretFromUri(
        'otpauth://totp/KNOQRA:ana%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=KNOQRA',
      ),
    ).toBe('JBSWY3DPEHPK3PXP');
  });

  it('returns null for anything that is not a usable URI', () => {
    expect(secretFromUri('not a uri')).toBeNull();
    expect(secretFromUri('otpauth://totp/KNOQRA:ana?issuer=KNOQRA')).toBeNull();
  });
});

describe('groupSecret', () => {
  it('splits the secret into readable groups of four', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });
});

describe('normalizeCode', () => {
  it('strips spaces from a typed or pasted code and keeps dashes', () => {
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('abcde-12345')).toBe('abcde-12345');
  });
});

describe('backupCodesFile', () => {
  it('writes a plain-text file with one code per line and a warning', () => {
    const text = backupCodesFile(['aaaaa-11111', 'bbbbb-22222']);
    expect(text).toContain('KNOQRA backup codes');
    expect(text).toContain('aaaaa-11111\nbbbbb-22222');
    expect(text).toMatch(/once/i);
  });
});

describe('needsTwoFactor', () => {
  it('is true only for a sign-in answer that asks for a second factor', () => {
    expect(needsTwoFactor({ twoFactorRedirect: true, twoFactorMethods: ['totp'] })).toBe(true);
    expect(needsTwoFactor({ twoFactorRedirect: false })).toBe(false);
    expect(needsTwoFactor({ user: { id: 'x' }, token: 't' })).toBe(false);
    expect(needsTwoFactor(null)).toBe(false);
    expect(needsTwoFactor(undefined)).toBe(false);
  });
});

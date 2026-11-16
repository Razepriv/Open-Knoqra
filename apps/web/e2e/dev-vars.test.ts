import { describe, expect, it } from 'vitest';
import { isMasterKey, migrationUrlFor, parseDevVars } from './dev-vars';

describe('parseDevVars', () => {
  it('reads plain pairs, skipping blank lines and comment lines', () => {
    expect(parseDevVars('# note\n\nA=1\n  B = two \n')).toEqual({ A: '1', B: 'two' });
  });

  it('tolerates CRLF line endings', () => {
    expect(parseDevVars('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('strips matching quotes and keeps # inside them', () => {
    expect(parseDevVars('A="x # y"\nB=\'p#q\'\nC="plain" # tail')).toEqual({
      A: 'x # y',
      B: 'p#q',
      C: 'plain',
    });
  });

  it('accepts an export prefix', () => {
    expect(parseDevVars('export A=1\nexport   B="2"')).toEqual({ A: '1', B: '2' });
  });

  it('drops inline comments on unquoted values but keeps a # without a space', () => {
    expect(parseDevVars('A=1 # why\nB=url#frag')).toEqual({ A: '1', B: 'url#frag' });
  });

  it('keeps = inside values and treats an empty value as empty', () => {
    expect(parseDevVars('A=b=c\nD=')).toEqual({ A: 'b=c', D: '' });
  });
});

describe('migrationUrlFor', () => {
  const admin = 'postgres://knoqra:knoqra@localhost:54329/knoqra';

  it('migrates the database the API uses, with the owner role', () => {
    expect(
      migrationUrlFor('postgres://knoqra_app:knoqra_app@localhost:54329/knoqra_s6', admin),
    ).toBe('postgres://knoqra:knoqra@localhost:54329/knoqra_s6');
  });

  it('keeps the API database host and port', () => {
    expect(migrationUrlFor('postgres://app:app@db.local:6543/other', admin)).toBe(
      'postgres://knoqra:knoqra@db.local:6543/other',
    );
  });
});

describe('isMasterKey', () => {
  it('accepts base64 of exactly 32 bytes, as the API does', () => {
    expect(isMasterKey('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=')).toBe(true);
  });

  it('refuses a missing key, the example placeholder, and a key of the wrong length', () => {
    expect(isMasterKey(undefined)).toBe(false);
    expect(isMasterKey('')).toBe(false);
    expect(isMasterKey('replace-me-with-openssl-rand-base64-32')).toBe(false);
    expect(isMasterKey('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e')).toBe(false); // 30 bytes
  });
});

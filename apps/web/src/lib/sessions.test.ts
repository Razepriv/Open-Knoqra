import { describe, expect, it } from 'vitest';
import { currentSessionToken, revokeLabel, toSessionRows } from './sessions';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function entry(
  id: string,
  token: string,
  updatedAt: string,
  extra: { userAgent?: string | null; ipAddress?: string | null } = {},
) {
  return {
    id,
    token,
    userAgent: CHROME,
    ipAddress: '203.0.113.7',
    updatedAt: new Date(updatedAt),
    createdAt: new Date(updatedAt),
    ...extra,
  };
}

describe('toSessionRows', () => {
  it('marks the current session and lists it first, then newest activity first', () => {
    const rows = toSessionRows(
      [
        entry('a', 'tok-a', '2026-11-12T10:00:00Z'),
        entry('b', 'tok-b', '2026-11-12T11:00:00Z'),
        entry('c', 'tok-c', '2026-11-11T09:00:00Z'),
      ],
      'tok-c',
    );
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(rows.map((r) => r.current)).toEqual([true, false, false]);
  });

  it('describes the device and tolerates missing address and agent', () => {
    const [row] = toSessionRows(
      [entry('a', 'tok-a', '2026-11-12T10:00:00Z', { userAgent: null, ipAddress: null })],
      'tok-a',
    );
    expect(row?.device).toBe('Unknown device');
    expect(row?.ip).toBeNull();
  });

  it('keeps the token for revoking but under its own field', () => {
    const [row] = toSessionRows([entry('a', 'tok-a', '2026-11-12T10:00:00Z')], 'tok-a');
    expect(row?.token).toBe('tok-a');
  });
});

describe('fail closed on an unknown current session', () => {
  it('refuses to build rows without a current token, so no row can offer Revoke by mistake', () => {
    expect(() => toSessionRows([entry('a', 'tok-a', '2026-11-12T10:00:00Z')], '')).toThrow();
  });

  it('refuses when the current token is not among the listed sessions', () => {
    expect(() =>
      toSessionRows([entry('a', 'tok-a', '2026-11-12T10:00:00Z')], 'tok-other'),
    ).toThrow();
  });
});

describe('currentSessionToken', () => {
  it('reads the token of the signed-in session', () => {
    expect(currentSessionToken({ data: { session: { token: 'tok-a' } }, error: null })).toBe(
      'tok-a',
    );
  });

  it.each([
    ['no session', { data: null, error: null }],
    ['an error', { data: null, error: { status: 500 } }],
    ['a session without a token', { data: { session: {} }, error: null }],
    ['an empty token', { data: { session: { token: '' } }, error: null }],
    ['not a result at all', undefined],
  ])('is null for %s', (_name, result) => {
    expect(currentSessionToken(result)).toBeNull();
  });
});

describe('revokeLabel', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const base = {
    id: 'a',
    token: 't',
    current: false,
    device: 'Chrome on Windows',
    lastActive: new Date('2026-11-12T07:00:00Z'),
  };

  it('tells two rows of the same browser apart by address and last activity', () => {
    expect(revokeLabel({ ...base, ip: '203.0.113.7' }, now, 'en')).toBe(
      'Revoke Chrome on Windows, 203.0.113.7, 5 hours ago',
    );
    expect(revokeLabel({ ...base, ip: null }, now, 'en')).toBe(
      'Revoke Chrome on Windows, 5 hours ago',
    );
  });
});

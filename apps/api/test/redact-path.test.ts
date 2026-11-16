import { describe, expect, it } from 'vitest';
import { redactPath } from '../src/lib/redact-path';

/** Synthetic, never a real token. */
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123';
const CONTACT_ID = `ct_${'0123456789abcdef'.repeat(2)}`;

describe('redactPath', () => {
  it.each([
    ['/api/auth/reset-password/abc123', '/api/auth/reset-password/[redacted]'],
    [`/api/auth/reset-password/${TOKEN}`, '/api/auth/reset-password/[redacted]'],
    ['/api/auth/verify-email/a/b', '/api/auth/verify-email/[redacted]/[redacted]'],
    ['/api/auth/organization/list-user-invitations', '/api/auth/organization/[redacted]'],
    ['/api/auth/get-session', '/api/auth/get-session'],
    ['/api/auth/', '/api/auth/'],
  ])('keeps only the first segment under /api/auth/ (%s)', (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });

  it('never includes the query string or fragment', () => {
    expect(redactPath(`/api/auth/reset-password/${TOKEN}?callbackURL=/reset#x`)).toBe(
      '/api/auth/reset-password/[redacted]',
    );
    expect(redactPath('/api/v1/contacts?q=someone')).toBe('/api/v1/contacts');
    expect(redactPath('/api/v1/contacts#top')).toBe('/api/v1/contacts');
  });

  it('keeps KNOQRA ids and route words readable', () => {
    expect(redactPath(`/api/v1/contacts/${CONTACT_ID}/duplicates`)).toBe(
      `/api/v1/contacts/${CONTACT_ID}/duplicates`,
    );
    expect(redactPath(`/api/v1/contacts/${CONTACT_ID}/do-not-contact`)).toBe(
      `/api/v1/contacts/${CONTACT_ID}/do-not-contact`,
    );
    expect(redactPath('/api/v1/some-very-long-route-name-here')).toBe(
      '/api/v1/some-very-long-route-name-here',
    );
    expect(redactPath('/api/health/deep')).toBe('/api/health/deep');
  });

  it.each([
    ['an unprefixed token', `/webhooks/${TOKEN}`, '/webhooks/[redacted]'],
    ['a UUID', '/x/123e4567-e89b-42d3-a456-426614174000', '/x/[redacted]'],
    ['an unknown prefix', `/x/zz_${'0123456789abcdef'.repeat(2)}`, '/x/[redacted]'],
    ['a JWT-like value', '/x/eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl', '/x/[redacted]'],
    ['a percent-encoded value', '/x/abc%2Fdef%3Dghi%2Bjkl', '/x/[redacted]'],
    ['an uppercase prefixed id', `/x/ct_${'0123456789ABCDEF'.repeat(2)}`, '/x/[redacted]'],
  ])('redacts a long credential-like segment anywhere (%s)', (_label, input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });

  it('leaves short segments alone', () => {
    expect(redactPath('/api/v1/contacts/abc123')).toBe('/api/v1/contacts/abc123');
    expect(redactPath('/')).toBe('/');
    expect(redactPath('')).toBe('');
  });
});

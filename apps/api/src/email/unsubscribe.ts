/**
 * Signed newsletter unsubscribe links. The token is an HMAC of the user id under the auth secret,
 * so a link works without signing in, names exactly one user, and cannot be forged or pointed at
 * someone else. It never expires: an old email's link must keep working.
 */

export const UNSUBSCRIBE_PATH = '/api/email/unsubscribe';

const PURPOSE = 'knoqra.newsletter.unsubscribe.v1';
const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${PURPOSE}:${userId}`));
  return base64url(mac);
}

/** Constant-time check of a token against the user id. */
export async function verifyUnsubscribeToken(
  secret: string,
  userId: string,
  token: string,
): Promise<boolean> {
  if (!userId || !token || token.length > 128) return false;
  const expected = await unsubscribeToken(secret, userId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** The one-click link for the email footer and the List-Unsubscribe header. */
export async function unsubscribeUrl(
  origin: string,
  secret: string,
  userId: string,
): Promise<string> {
  const url = new URL(UNSUBSCRIBE_PATH, origin);
  url.searchParams.set('u', userId);
  url.searchParams.set('t', await unsubscribeToken(secret, userId));
  return url.href;
}

/** RFC 2369 and RFC 8058 headers, so mail apps offer their own one-click unsubscribe. */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

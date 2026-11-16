import type { Env } from '../env';

/**
 * Short-lived, signed links to message attachments. The file route (`GET /api/media/{id}`) needs no
 * session, so an `<img>` in the Desk and the provider fetching an outbound file can both use it;
 * the HMAC binds the attachment id, its organization and the expiry, so a link cannot be widened,
 * moved to another workspace or kept past its time. The key is derived from BETTER_AUTH_SECRET.
 */
export const MEDIA_PATH = '/api/media';

/** Desk links last at least an hour; rounding the expiry keeps a link stable (and cacheable). */
export const DESK_LINK_SECONDS = 3600;
/** The provider may fetch an outbound file late or retry: its link lasts a day. */
export const PROVIDER_LINK_SECONDS = 86_400;

const encoder = new TextEncoder();
/** Derived keys by secret: deterministic, so sharing them across requests is safe. */
const keys = new Map<string, Promise<CryptoKey>>();

function base64Url(bytes: ArrayBuffer): string {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function derivedKey(secret: string): Promise<CryptoKey> {
  const cached = keys.get(secret);
  if (cached) return cached;
  const made = (async () => {
    const root = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const derived = await crypto.subtle.sign('HMAC', root, encoder.encode('knoqra:media-url:v1'));
    return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  })();
  keys.set(secret, made);
  return made;
}

const payload = (attachmentId: string, orgId: string, expires: number) =>
  encoder.encode(`${attachmentId}\n${orgId}\n${expires}`);

async function signature(env: Env, attachmentId: string, orgId: string, expires: number) {
  const key = await derivedKey(env.BETTER_AUTH_SECRET);
  return base64Url(await crypto.subtle.sign('HMAC', key, payload(attachmentId, orgId, expires)));
}

/** The expiry for a link valid at least `seconds` from now, rounded up to the hour. */
export function linkExpiry(nowMs: number, seconds: number): number {
  const at = Math.floor(nowMs / 1000) + seconds;
  return Math.ceil(at / 3600) * 3600;
}

/**
 * A signed link to an attachment: relative (`/api/media/...`) for the Desk, which reaches the API
 * through its own origin, or absolute on `origin` for the provider.
 */
export async function signedMediaUrl(
  env: Env,
  input: { attachmentId: string; orgId: string; seconds: number; origin?: string; nowMs?: number },
): Promise<{ url: string; expiresAt: Date }> {
  const expires = linkExpiry(input.nowMs ?? Date.now(), input.seconds);
  const s = await signature(env, input.attachmentId, input.orgId, expires);
  const query = new URLSearchParams({ o: input.orgId, e: String(expires), s });
  const path = `${MEDIA_PATH}/${encodeURIComponent(input.attachmentId)}?${query}`;
  return { url: `${input.origin ?? ''}${path}`, expiresAt: new Date(expires * 1000) };
}

/** Constant-time comparison of two strings of base64url text. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type LinkCheck = { ok: true; orgId: string; expires: number } | { ok: false };

/** Whether a link's organization, expiry and signature are valid for this attachment now. */
export async function verifyMediaUrl(
  env: Env,
  input: {
    attachmentId: string;
    o: string | undefined;
    e: string | undefined;
    s: string | undefined;
    nowMs?: number;
  },
): Promise<LinkCheck> {
  const { o, e, s } = input;
  if (!o || !e || !s || !/^\d{1,12}$/.test(e) || o.length > 64 || s.length > 64)
    return { ok: false };
  const expires = Number(e);
  if (expires * 1000 <= (input.nowMs ?? Date.now())) return { ok: false };
  const expected = await signature(env, input.attachmentId, o, expires);
  return sameText(expected, s) ? { ok: true, orgId: o, expires } : { ok: false };
}

/** Where the provider fetches outbound files: API_PUBLIC_ORIGIN, else this request's origin. */
export function publicOrigin(env: Env, requestUrl?: string): string | null {
  const configured = env.API_PUBLIC_ORIGIN?.trim().replace(/\/+$/, '');
  if (configured && /^https:\/\//.test(configured)) return configured;
  if (!requestUrl) return null;
  const origin = new URL(requestUrl).origin;
  return origin.startsWith('https://') ? origin : null;
}

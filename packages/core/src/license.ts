/**
 * Self-host license keys: an Ed25519 signature over a small JSON payload, checked offline.
 *
 *     KNOQRA-LICENSE-1.<base64url payload>.<base64url signature>
 *
 * The payload is `{ v: 1, sub, login, iat, edition }`: the GitHub user id, the GitHub login, the
 * issue date (YYYY-MM-DD, UTC) and the edition (`selfhost`). The signature covers the ASCII text
 * `KNOQRA-LICENSE-1.<base64url payload>`, so the prefix is bound to the key. KNOQRA's key issuer
 * signs with the private key; a self-hosted instance verifies with the public key built into the
 * code (license-public-key.ts). Runs on WebCrypto, in Workers and Node.
 */

export const LICENSE_PREFIX = 'KNOQRA-LICENSE-1';
export const LICENSE_MAX_LENGTH = 1024;
/** A key dated more than this far ahead of the verifier's clock is refused. */
const FUTURE_TOLERANCE_MS = 36 * 60 * 60 * 1000;

export type LicenseEdition = 'selfhost';

export interface LicensePayload {
  v: 1;
  /** GitHub's numeric user id, as text. Stays the same when the login is renamed. */
  sub: string;
  login: string;
  /** Issue date, `YYYY-MM-DD` (UTC). */
  iat: string;
  edition: LicenseEdition;
}

export type LicenseFailure =
  /** The build has no public key embedded, so no key can be checked. */
  | 'no_public_key'
  /** Not a KNOQRA license key: wrong prefix, shape, encoding or payload. */
  | 'malformed'
  /** The signature does not match this build's public key. */
  | 'bad_signature'
  /** A valid key, but not for a self-hosted instance. */
  | 'wrong_edition'
  /** Dated in the future. */
  | 'future_date';

export type LicenseCheck =
  | { ok: true; license: LicensePayload }
  | { ok: false; reason: LicenseFailure };

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const ED25519 = { name: 'Ed25519' } as const;
const encoder = new TextEncoder();
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NUMERIC_ID = /^[1-9][0-9]{0,19}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Null when `text` is not unpadded base64url. */
export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  try {
    return base64ToBytes(padded);
  } catch {
    return null;
  }
}

/** A real calendar date in `YYYY-MM-DD` form. */
function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The payload, or null when any field is missing, extra or out of shape. */
export function parseLicensePayload(value: unknown): LicensePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'edition,iat,login,sub,v') return null;
  const { v, sub, login, iat, edition } = record;
  if (v !== 1) return null;
  if (typeof sub !== 'string' || !NUMERIC_ID.test(sub)) return null;
  if (typeof login !== 'string' || !GITHUB_LOGIN.test(login)) return null;
  if (typeof iat !== 'string' || !isIsoDate(iat)) return null;
  if (typeof edition !== 'string') return null;
  return { v: 1, sub, login, iat, edition: edition as LicenseEdition };
}

/** Today's date in UTC, as a license `iat`. */
export function licenseDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Imports the embedded public key: base64 of the raw 32-byte Ed25519 key. */
export async function importLicensePublicKey(publicKeyB64: string): Promise<Key | null> {
  const trimmed = publicKeyB64.trim();
  if (!trimmed) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(trimmed);
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  try {
    return await crypto.subtle.importKey('raw', raw, ED25519, false, ['verify']);
  } catch {
    return null;
  }
}

/**
 * Imports a signing key (base64 of a PKCS#8 Ed25519 private key) and
 * derives its public half, so the issuer can refuse to sign with a key no instance can verify.
 * Null when the text is not such a key.
 */
export async function importLicenseSigningKey(
  pkcs8B64: string,
): Promise<{ privateKey: Key; publicKeyB64: string } | null> {
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = base64ToBytes(pkcs8B64.trim());
  } catch {
    return null;
  }
  try {
    const extractable = await crypto.subtle.importKey('pkcs8', der, ED25519, true, ['sign']);
    const jwk = (await crypto.subtle.exportKey('jwk', extractable)) as { x?: string };
    const publicRaw = jwk.x ? base64UrlDecode(jwk.x) : null;
    if (publicRaw?.length !== 32) return null;
    const privateKey = await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign']);
    return { privateKey, publicKeyB64: bytesToBase64(publicRaw) };
  } catch {
    return null;
  }
}

/** Signs `payload` into a license key. */
export async function encodeLicense(payload: LicensePayload, privateKey: Key): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signed = `${LICENSE_PREFIX}.${body}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(ED25519, privateKey, encoder.encode(signed)),
  );
  return `${signed}.${base64UrlEncode(signature)}`;
}

/**
 * Checks a license key against `publicKeyB64` (the embedded key). Offline: no network, no clock
 * beyond refusing keys dated in the future. Surrounding whitespace is ignored, so a pasted key
 * with a trailing newline still works.
 */
export async function verifyLicense(
  key: string,
  publicKeyB64: string,
  now: Date = new Date(),
): Promise<LicenseCheck> {
  const publicKey = publicKeyB64.trim() ? await importLicensePublicKey(publicKeyB64) : null;
  if (!publicKey) return { ok: false, reason: 'no_public_key' };
  const text = key.trim();
  if (text.length === 0 || text.length > LICENSE_MAX_LENGTH)
    return { ok: false, reason: 'malformed' };
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return { ok: false, reason: 'malformed' };
  const [, body = '', sig = ''] = parts;
  const payloadBytes = base64UrlDecode(body);
  const signature = base64UrlDecode(sig);
  if (!payloadBytes || !signature || signature.length !== 64)
    return { ok: false, reason: 'malformed' };

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      ED25519,
      publicKey,
      signature,
      encoder.encode(`${LICENSE_PREFIX}.${body}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payloadBytes),
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const payload = parseLicensePayload(json);
  if (!payload) return { ok: false, reason: 'malformed' };
  if (payload.edition !== 'selfhost') return { ok: false, reason: 'wrong_edition' };
  if (Date.parse(`${payload.iat}T00:00:00Z`) > now.getTime() + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: 'future_date' };
  }
  return { ok: true, license: payload };
}

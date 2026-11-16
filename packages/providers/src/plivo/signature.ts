import { bytesToBase64 } from '../telnyx/base64';
import { compareBytes, type FormPair, parseFormBytes } from './form';

export const SIGNATURE_HEADER = 'x-plivo-signature-v3';
export const NONCE_HEADER = 'x-plivo-signature-v3-nonce';

const encoder = new TextEncoder();
const MAX_SIGNATURES = 8;

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The URL's own query as Plivo signs it: names sorted, values sorted, `k=v` joined with `&`. */
function sortedQuery(url: URL): string {
  const byName = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) byName.set(k, [...(byName.get(k) ?? []), v]);
  return [...byName.keys()]
    .sort()
    .flatMap((k) => (byName.get(k) ?? []).sort().map((v) => `${k}=${v}`))
    .join('&');
}

/** POST parameters as Plivo signs them: names sorted, then values, each `name` + `value`, no separators. */
function sortedParams(pairs: FormPair[]): Uint8Array {
  const sorted = [...pairs].sort(
    (a, b) => compareBytes(a.key, b.key) || compareBytes(a.value, b.value),
  );
  return concat(sorted.flatMap((p) => [p.key, p.value]));
}

/**
 * The bytes Plivo's V3 signature covers for a POST, as the official SDK validators build them
 * (plivo-node `lib/utils/v3Security.js`, plivo-python `signature_v3.py`): the URL without its
 * fragment, its sorted query, the sorted POST parameters, then `.` and the nonce.
 */
export function v3SignedBytes(
  url: string,
  nonce: string,
  body: Uint8Array,
): Uint8Array<ArrayBuffer> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const query = sortedQuery(parsed);
  const params = parseFormBytes(body);
  let head: string;
  if (params.length === 0) head = query.length > 0 ? `${base}?${query}` : base;
  else head = query.length > 0 ? `${base}?${query}.` : `${base}?`;
  const parts: Uint8Array[] = [encoder.encode(head)];
  if (params.length > 0) parts.push(sortedParams(params));
  parts.push(encoder.encode(`.${nonce}`));
  return concat(parts);
}

async function hmacBase64(key: string, message: Uint8Array<ArrayBuffer>): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', imported, message)));
}

/** The V3 signature of a POST: base64 HMAC-SHA256 under the auth token. */
export async function signPlivoV3(input: {
  url: string;
  nonce: string;
  authToken: string;
  body: Uint8Array;
}): Promise<string | null> {
  const message = v3SignedBytes(input.url, input.nonce, input.body);
  return message === null ? null : hmacBase64(input.authToken, message);
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks `X-Plivo-Signature-V3` for a POST to `url`. The header may list several signatures, one
 * per active auth token; any one match passes. Comparison is constant time per candidate.
 */
export async function verifyPlivoV3(input: {
  url: string;
  headers: Headers;
  authToken: string;
  body: Uint8Array;
}): Promise<boolean> {
  const header = input.headers.get(SIGNATURE_HEADER);
  const nonce = input.headers.get(NONCE_HEADER);
  if (header === null || nonce === null || nonce.length === 0 || input.authToken.length === 0) {
    return false;
  }
  const candidates = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (candidates.length === 0 || candidates.length > MAX_SIGNATURES) return false;
  const expected = await signPlivoV3({
    url: input.url,
    nonce,
    authToken: input.authToken,
    body: input.body,
  });
  if (expected === null) return false;
  let matched = false;
  for (const candidate of candidates) matched = sameText(candidate, expected) || matched;
  return matched;
}

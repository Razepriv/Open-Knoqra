/**
 * Envelope encryption for provider API keys. A fresh 256-bit data key (DEK) seals the secret with
 * AES-GCM; the master key (a Worker secret) wraps the DEK with AES-GCM. Both operations bind the
 * same AAD (`<orgId>:<provider>:api_key`), so a sealed value cannot be moved to another tenant or
 * swapped between providers. Nothing here logs, and errors never carry key material.
 */

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  dekWrapped: string;
  dekIv: string;
  keyFingerprint: string;
}

export interface SecretEnvelopeOptions {
  masterKeyBase64: string;
  aad: string;
}

export type SecretEnvelopeErrorCode = 'wrong_key' | 'tampered' | 'invalid_master_key';

export class SecretEnvelopeError extends Error {
  constructor(readonly code: SecretEnvelopeErrorCode) {
    super(`Secret envelope error: ${code}`);
    this.name = 'SecretEnvelopeError';
  }
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const FINGERPRINT_HEX_CHARS = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Bytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function masterKeyBytes(masterKeyBase64: string): Bytes {
  let bytes: Bytes;
  try {
    bytes = fromBase64(masterKeyBase64);
  } catch {
    throw new SecretEnvelopeError('invalid_master_key');
  }
  if (bytes.length !== KEY_BYTES) throw new SecretEnvelopeError('invalid_master_key');
  return bytes;
}

/** True when `value` is base64 of exactly 32 bytes. */
export function isValidMasterKey(value: string | undefined): value is string {
  if (!value) return false;
  try {
    masterKeyBytes(value);
    return true;
  } catch {
    return false;
  }
}

async function fingerprint(raw: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  return toHex(digest).slice(0, FINGERPRINT_HEX_CHARS);
}

function aesKey(raw: Bytes, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

export async function sealSecret(
  plaintext: string,
  opts: SecretEnvelopeOptions,
): Promise<SealedSecret> {
  const masterRaw = masterKeyBytes(opts.masterKeyBase64);
  const additionalData = encoder.encode(opts.aad);
  const dekRaw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const dekIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    await aesKey(dekRaw, 'encrypt'),
    encoder.encode(plaintext),
  );
  const dekWrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: dekIv, additionalData },
    await aesKey(masterRaw, 'encrypt'),
    dekRaw,
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iv: toBase64(iv),
    dekWrapped: toBase64(new Uint8Array(dekWrapped)),
    dekIv: toBase64(dekIv),
    keyFingerprint: await fingerprint(masterRaw),
  };
}

export async function openSecret(
  sealed: SealedSecret,
  opts: SecretEnvelopeOptions,
): Promise<string> {
  const masterRaw = masterKeyBytes(opts.masterKeyBase64);
  if ((await fingerprint(masterRaw)) !== sealed.keyFingerprint) {
    throw new SecretEnvelopeError('wrong_key');
  }
  const additionalData = encoder.encode(opts.aad);
  try {
    const dekRaw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.dekIv), additionalData },
      await aesKey(masterRaw, 'decrypt'),
      fromBase64(sealed.dekWrapped),
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData },
      await aesKey(new Uint8Array(dekRaw), 'decrypt'),
      fromBase64(sealed.ciphertext),
    );
    return decoder.decode(plain);
  } catch {
    throw new SecretEnvelopeError('tampered');
  }
}

export function lastFour(value: string): string {
  return value.slice(-4);
}

/** The AAD every Telnyx API key is sealed under. */
export function telnyxKeyAad(orgId: string): string {
  return providerKeyAad(orgId, 'telnyx');
}

/**
 * The AAD a provider's secret is sealed under: `<orgId>:<provider>:api_key`. A Telnyx key and a
 * Plivo auth token of one workspace cannot be swapped for each other, nor moved to another tenant.
 */
export function providerKeyAad(orgId: string, provider: string): string {
  return `${orgId}:${provider}:api_key`;
}

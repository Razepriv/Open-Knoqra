import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  encodeLicense,
  importLicenseSigningKey,
  LICENSE_PREFIX,
  type LicensePayload,
  licenseDate,
  parseLicensePayload,
  verifyLicense,
} from './license';
import { LICENSE_PUBLIC_KEY } from './license-public-key';

type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeyPair = { privateKey: Key; publicKey: Key };

async function keyPair(): Promise<{ pair: KeyPair; publicB64: string; pkcs8B64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as KeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    pair,
    publicB64: Buffer.from(raw).toString('base64'),
    pkcs8B64: Buffer.from(pkcs8).toString('base64'),
  };
}

const payload: LicensePayload = {
  v: 1,
  sub: '583231',
  login: 'octocat',
  iat: '2026-11-15',
  edition: 'selfhost',
};
const NOW = new Date('2026-11-15T12:00:00Z');

/** Signs arbitrary payload JSON, as a forger holding the private key could. */
async function signRaw(json: string, privateKey: Key): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(json));
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(`${LICENSE_PREFIX}.${body}`),
    ),
  );
  return `${LICENSE_PREFIX}.${body}.${base64UrlEncode(sig)}`;
}

describe('license keys', () => {
  it('round-trips: a signed key verifies and returns its payload', async () => {
    const { pair, publicB64 } = await keyPair();
    const key = await encodeLicense(payload, pair.privateKey);
    expect(key.startsWith(`${LICENSE_PREFIX}.`)).toBe(true);
    expect(key.split('.')).toHaveLength(3);
    await expect(verifyLicense(key, publicB64, NOW)).resolves.toEqual({
      ok: true,
      license: payload,
    });
    // A pasted key with surrounding whitespace still verifies.
    await expect(verifyLicense(`  ${key}\n`, publicB64, NOW)).resolves.toMatchObject({ ok: true });
  });

  it('rejects a key signed by another private key', async () => {
    const signer = await keyPair();
    const other = await keyPair();
    const key = await encodeLicense(payload, signer.pair.privateKey);
    await expect(verifyLicense(key, other.publicB64, NOW)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload (a different login) under the original signature', async () => {
    const { pair, publicB64 } = await keyPair();
    const key = await encodeLicense(payload, pair.privateKey);
    const [prefix, , sig] = key.split('.');
    const forged = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify({ ...payload, login: 'mallory' })),
    );
    await expect(verifyLicense(`${prefix}.${forged}.${sig}`, publicB64, NOW)).resolves.toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered signature', async () => {
    const { pair, publicB64 } = await keyPair();
    const key = await encodeLicense(payload, pair.privateKey);
    const [prefix, body, sig = ''] = key.split('.');
    const bytes = base64UrlDecode(sig);
    if (!bytes) throw new Error('signature did not decode');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    await expect(
      verifyLicense(`${prefix}.${body}.${base64UrlEncode(bytes)}`, publicB64, NOW),
    ).resolves.toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('binds the prefix: the same body and signature under another prefix is malformed', async () => {
    const { pair, publicB64 } = await keyPair();
    const key = await encodeLicense(payload, pair.privateKey);
    const swapped = key.replace(LICENSE_PREFIX, 'KNOQRA-LICENSE-2');
    await expect(verifyLicense(swapped, publicB64, NOW)).resolves.toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects malformed keys of every shape', async () => {
    const { publicB64 } = await keyPair();
    for (const bad of [
      '',
      'hello',
      `${LICENSE_PREFIX}.abc`,
      `${LICENSE_PREFIX}.abc.def.ghi`,
      `${LICENSE_PREFIX}.!!!.???`,
      `${LICENSE_PREFIX}.${'A'.repeat(2000)}.AA`,
      `${LICENSE_PREFIX}.eyJ2IjoxfQ.${base64UrlEncode(new Uint8Array(10))}`,
    ]) {
      await expect(verifyLicense(bad, publicB64, NOW)).resolves.toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a correctly signed payload that is not valid JSON or has the wrong fields', async () => {
    const { pair, publicB64 } = await keyPair();
    for (const json of [
      'not json',
      JSON.stringify({ ...payload, v: 2 }),
      JSON.stringify({ ...payload, extra: true }),
      JSON.stringify({ ...payload, login: 'bad login!' }),
      JSON.stringify({ ...payload, sub: 'abc' }),
      JSON.stringify({ ...payload, iat: '2026-02-30' }),
      JSON.stringify([payload]),
    ]) {
      const key = await signRaw(json, pair.privateKey);
      await expect(verifyLicense(key, publicB64, NOW)).resolves.toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a valid signature over a key for another edition', async () => {
    const { pair, publicB64 } = await keyPair();
    const key = await signRaw(JSON.stringify({ ...payload, edition: 'cloud' }), pair.privateKey);
    await expect(verifyLicense(key, publicB64, NOW)).resolves.toEqual({
      ok: false,
      reason: 'wrong_edition',
    });
  });

  it('rejects a key dated in the future, beyond clock skew', async () => {
    const { pair, publicB64 } = await keyPair();
    const tomorrow = await encodeLicense({ ...payload, iat: '2026-11-16' }, pair.privateKey);
    await expect(verifyLicense(tomorrow, publicB64, NOW)).resolves.toMatchObject({ ok: true });
    const later = await encodeLicense({ ...payload, iat: '2026-11-20' }, pair.privateKey);
    await expect(verifyLicense(later, publicB64, NOW)).resolves.toEqual({
      ok: false,
      reason: 'future_date',
    });
  });

  it('fails closed without a usable public key', async () => {
    const { pair } = await keyPair();
    const key = await encodeLicense(payload, pair.privateKey);
    for (const publicKey of ['', '   ', 'not base64 at all', Buffer.alloc(31).toString('base64')]) {
      await expect(verifyLicense(key, publicKey, NOW)).resolves.toEqual({
        ok: false,
        reason: 'no_public_key',
      });
    }
  });

  it('the embedded public key is empty or a 32-byte key', () => {
    const decoded = Buffer.from(LICENSE_PUBLIC_KEY, 'base64');
    expect(LICENSE_PUBLIC_KEY === '' || decoded.length === 32).toBe(true);
  });
});

describe('importLicenseSigningKey', () => {
  it('derives the public half that verifies keys it signs', async () => {
    const { pkcs8B64, publicB64 } = await keyPair();
    const imported = await importLicenseSigningKey(pkcs8B64);
    expect(imported?.publicKeyB64).toBe(publicB64);
    if (!imported) throw new Error('import failed');
    const key = await encodeLicense(payload, imported.privateKey);
    await expect(verifyLicense(key, publicB64, NOW)).resolves.toMatchObject({ ok: true });
  });

  it('returns null for text that is not a PKCS#8 Ed25519 key', async () => {
    for (const bad of ['', 'nope', Buffer.alloc(48).toString('base64')]) {
      await expect(importLicenseSigningKey(bad)).resolves.toBeNull();
    }
  });
});

describe('helpers', () => {
  it('base64url round-trips and rejects other alphabets', () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63, 1]);
    const text = base64UrlEncode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(text)).toEqual(bytes);
    expect(base64UrlDecode('ab+/')).toBeNull();
    expect(base64UrlDecode('a')).toBeNull();
  });

  it('licenseDate is the UTC calendar date', () => {
    expect(licenseDate(new Date('2026-11-15T23:59:59Z'))).toBe('2026-11-15');
  });

  it('parseLicensePayload accepts exactly the five fields', () => {
    expect(parseLicensePayload(payload)).toEqual(payload);
    expect(parseLicensePayload(null)).toBeNull();
    expect(parseLicensePayload({ ...payload, iat: '15-11-2026' })).toBeNull();
  });
});

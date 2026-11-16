import { describe, expect, it } from 'vitest';
import {
  lastFour,
  openSecret,
  type SealedSecret,
  SecretEnvelopeError,
  sealSecret,
} from '../src/lib/secret-envelope';

// Non-secret fixtures: patterned bytes, never used outside tests.
const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const AAD = 'org_a:telnyx:api_key';
const PLAINTEXT = 'KEY0123456789abcdefghijklmnop';

function flipByte(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return btoa(String.fromCharCode(...bytes));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SecretEnvelopeError);
  expect((error as SecretEnvelopeError).code).toBe(code);
}

describe('secret envelope', () => {
  it('round trips', async () => {
    const sealed = await sealSecret(PLAINTEXT, { masterKeyBase64: KEY_A, aad: AAD });
    expect(await openSecret(sealed, { masterKeyBase64: KEY_A, aad: AAD })).toBe(PLAINTEXT);
  });

  it('differs in every field except the fingerprint across seals', async () => {
    const opts = { masterKeyBase64: KEY_A, aad: AAD };
    const one = await sealSecret(PLAINTEXT, opts);
    const two = await sealSecret(PLAINTEXT, opts);
    expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(one.iv).not.toBe(two.iv);
    expect(one.dekWrapped).not.toBe(two.dekWrapped);
    expect(one.dekIv).not.toBe(two.dekIv);
    expect(one.keyFingerprint).toBe(two.keyFingerprint);
    expect(one.keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('detects a flipped ciphertext byte', async () => {
    const sealed = await sealSecret(PLAINTEXT, { masterKeyBase64: KEY_A, aad: AAD });
    const bad: SealedSecret = { ...sealed, ciphertext: flipByte(sealed.ciphertext) };
    await expectCode(openSecret(bad, { masterKeyBase64: KEY_A, aad: AAD }), 'tampered');
  });

  it('rejects another organization AAD', async () => {
    const sealed = await sealSecret(PLAINTEXT, { masterKeyBase64: KEY_A, aad: AAD });
    await expectCode(
      openSecret(sealed, { masterKeyBase64: KEY_A, aad: 'org_b:telnyx:api_key' }),
      'tampered',
    );
  });

  it('reports another master key as wrong_key', async () => {
    const sealed = await sealSecret(PLAINTEXT, { masterKeyBase64: KEY_A, aad: AAD });
    await expectCode(openSecret(sealed, { masterKeyBase64: KEY_B, aad: AAD }), 'wrong_key');
  });

  it('never contains the plaintext in the sealed JSON', async () => {
    const sealed = await sealSecret(PLAINTEXT, { masterKeyBase64: KEY_A, aad: AAD });
    expect(JSON.stringify(sealed)).not.toContain(PLAINTEXT);
  });

  it('rejects a master key that is not 32 bytes', async () => {
    await expect(
      sealSecret(PLAINTEXT, { masterKeyBase64: btoa('short'), aad: AAD }),
    ).rejects.toThrow();
  });

  it('lastFour returns the final four characters', () => {
    expect(lastFour('abcdefgh')).toBe('efgh');
  });
});

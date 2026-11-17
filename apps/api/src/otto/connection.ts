import { type AiCredentialKind, type AiCredentialRow, aiCredential, type Tx } from '@knoqra/db';
import { lastFour, openSecret, type SealedSecret, sealSecret } from '../lib/secret-envelope';

/**
 * The AAD a workspace's Otto secret is sealed under: `<orgId>:otto:<kind>`. It cannot be moved to
 * another workspace, nor swapped with a telephony key or between an API key and a ChatGPT token.
 */
export const ottoSecretAad = (orgId: string, kind: AiCredentialKind) => `${orgId}:otto:${kind}`;

/** The tokens of a ChatGPT sign-in, sealed as JSON. */
export interface ChatGptTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** The workspace's Otto connection, or null. Runs in the workspace's tenant transaction. */
export async function loadOttoCredential(tx: Tx): Promise<AiCredentialRow | null> {
  const [row] = await tx.select().from(aiCredential).limit(1);
  return row ?? null;
}

const sealedOf = (row: AiCredentialRow): SealedSecret => ({
  ciphertext: row.secretCiphertext,
  iv: row.secretIv,
  dekWrapped: row.dekWrapped,
  dekIv: row.dekIv,
  keyFingerprint: row.keyFingerprint,
});

/** The plaintext secret: the API key, or the ChatGPT token JSON. Throws SecretEnvelopeError. */
export function openOttoSecret(row: AiCredentialRow, masterKeyBase64: string): Promise<string> {
  return openSecret(sealedOf(row), {
    masterKeyBase64,
    aad: ottoSecretAad(row.organizationId, row.kind),
  });
}

export interface SaveOttoCredential {
  orgId: string;
  userId: string;
  masterKeyBase64: string;
  kind: AiCredentialKind;
  /** The API key, or `JSON.stringify(ChatGptTokens)`. */
  secret: string;
  model: string | null;
  expiresAt: Date | null;
}

/** Seals and stores the workspace's connection, replacing any earlier one. */
export async function saveOttoCredential(tx: Tx, input: SaveOttoCredential) {
  const sealed = await sealSecret(input.secret, {
    masterKeyBase64: input.masterKeyBase64,
    aad: ottoSecretAad(input.orgId, input.kind),
  });
  const values = {
    kind: input.kind,
    secretCiphertext: sealed.ciphertext,
    secretIv: sealed.iv,
    dekWrapped: sealed.dekWrapped,
    dekIv: sealed.dekIv,
    keyFingerprint: sealed.keyFingerprint,
    secretLast4: input.kind === 'api_key' ? lastFour(input.secret) : null,
    model: input.model,
    expiresAt: input.expiresAt,
    createdBy: input.userId,
  };
  const [row] = await tx
    .insert(aiCredential)
    .values({ organizationId: input.orgId, ...values })
    .onConflictDoUpdate({
      target: aiCredential.organizationId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('ai credential upsert returned no row');
  return row;
}

/** Removes the workspace's connection. True when there was one. */
export async function deleteOttoCredential(tx: Tx): Promise<boolean> {
  const removed = await tx.delete(aiCredential).returning({ id: aiCredential.id });
  return removed.length > 0;
}

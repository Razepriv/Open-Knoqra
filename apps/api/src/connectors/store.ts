import {
  type ProviderCredentialRow,
  providerCredential,
  providerNumberRoute,
  type Tx,
} from '@knoqra/db';
import { and, eq, ne } from 'drizzle-orm';
import type { Tenant } from '../lib/context';
import { lastFour, providerKeyAad, SecretEnvelopeError, sealSecret } from '../lib/secret-envelope';
import { loadConnection } from '../lib/voice-provider';
import { dropTelnyxSenders } from '../messaging/senders';
import { type ConnectorProvider, openConnectionSecret } from './registry';

/** Another workspace owns the number. Generic on purpose: never says who. */
export class NumberConflictError extends Error {}

/** The workspace is connected to another provider; it must disconnect that one first. */
export class ConnectorConflictError extends Error {
  constructor(readonly connected: ConnectorProvider) {
    super(`connected to ${connected}`);
    this.name = 'ConnectorConflictError';
  }
}

/** Claims the number for this organization, or throws when another organization owns it. */
export async function claimNumber(
  tx: Tx,
  orgId: string,
  e164: string,
  provider: ConnectorProvider = 'telnyx',
): Promise<void> {
  await tx
    .insert(providerNumberRoute)
    .values({ provider, e164, organizationId: orgId })
    .onConflictDoNothing();
  // The route table has no RLS: always filter by organization_id ourselves.
  const [owner] = await tx
    .select({ organizationId: providerNumberRoute.organizationId })
    .from(providerNumberRoute)
    .where(and(eq(providerNumberRoute.provider, provider), eq(providerNumberRoute.e164, e164)));
  if (owner?.organizationId !== orgId) throw new NumberConflictError();
  await tx
    .delete(providerNumberRoute)
    .where(
      and(
        eq(providerNumberRoute.provider, provider),
        eq(providerNumberRoute.organizationId, orgId),
        ne(providerNumberRoute.e164, e164),
      ),
    );
}

export interface SaveConnectionInput {
  tenant: Tenant;
  masterKeyBase64: string;
  provider: ConnectorProvider;
  /** The Telnyx API key or the Plivo auth token. */
  secret: string;
  /** The Telnyx credential connection or the Plivo application. */
  connectionId: string;
  /** The Plivo Auth ID; null for Telnyx. */
  accountId: string | null;
  callerIdE164: string;
  /** Telnyx only. Undefined keeps the stored key. */
  webhookPublicKey?: string | undefined;
  /**
   * Whether the caller id may route inbound calls (provider_number_route). False in production:
   * the number is unverified user input until a number sync proves it (ruling R28).
   */
  routeNumber: boolean;
}

/** The stored secret, or null when it cannot be opened (treated as changed). */
async function previousSecret(row: ProviderCredentialRow, masterKeyBase64: string) {
  try {
    return await openConnectionSecret(row, masterKeyBase64);
  } catch (error) {
    if (error instanceof SecretEnvelopeError) return null;
    throw error;
  }
}

/**
 * Saves the workspace's connector (RLS-scoped `tx`). A workspace holds one: saving a provider
 * other than the connected one throws ConnectorConflictError and changes nothing. A new secret,
 * account or connection clears the stored browser identity, and drops the Telnyx messaging
 * senders that the old credential proved (ruling AP).
 */
export async function saveConnection(
  tx: Tx,
  input: SaveConnectionInput,
): Promise<ProviderCredentialRow> {
  const { tenant, masterKeyBase64, provider, secret } = input;
  const existing = await loadConnection(tx);
  if (existing && existing.provider !== provider) {
    throw new ConnectorConflictError(existing.provider);
  }
  const sealed = await sealSecret(secret, {
    masterKeyBase64,
    aad: providerKeyAad(tenant.orgId, provider),
  });
  const columns = {
    apiKeyCiphertext: sealed.ciphertext,
    apiKeyIv: sealed.iv,
    dekWrapped: sealed.dekWrapped,
    dekIv: sealed.dekIv,
    keyFingerprint: sealed.keyFingerprint,
    apiKeyLast4: lastFour(secret),
    connectionId: input.connectionId,
    accountId: input.accountId,
    callerIdE164: input.callerIdE164,
    ...(input.webhookPublicKey === undefined ? {} : { webhookPublicKey: input.webhookPublicKey }),
  };
  if (input.routeNumber) await claimNumber(tx, tenant.orgId, input.callerIdE164, provider);
  if (!existing) {
    // A concurrent first save in the same workspace may have inserted meanwhile: update that row
    // when it is the same provider. The browser identity is cleared, as for a new secret.
    const [created] = await tx
      .insert(providerCredential)
      .values({ organizationId: tenant.orgId, provider, createdBy: tenant.userId, ...columns })
      .onConflictDoUpdate({
        target: [providerCredential.organizationId],
        set: { ...columns, telephonyCredentialId: null, updatedAt: new Date() },
        setWhere: eq(providerCredential.provider, provider),
      })
      .returning();
    if (!created) {
      const winner = await loadConnection(tx);
      throw new ConnectorConflictError(winner?.provider ?? provider);
    }
    // No credential proved any Telnyx sender before this one (ruling AP).
    await dropTelnyxSenders(tx);
    return created;
  }
  const secretChanged = (await previousSecret(existing, masterKeyBase64)) !== secret;
  const accountChanged = existing.accountId !== input.accountId;
  // Another key may be another account: its senders were proved with the old one (AP).
  if (secretChanged || accountChanged) await dropTelnyxSenders(tx);
  const connectionChanged = existing.connectionId !== input.connectionId;
  const [updated] = await tx
    .update(providerCredential)
    .set({
      ...columns,
      telephonyCredentialId:
        secretChanged || accountChanged || connectionChanged
          ? null
          : existing.telephonyCredentialId,
    })
    .where(eq(providerCredential.id, existing.id))
    .returning();
  if (!updated) throw new Error('credential update returned no row');
  return updated;
}

/**
 * Disconnects the workspace from `provider` (RLS-scoped `tx`): the stored connection, the Telnyx
 * senders it proved and its inbound number routes. Returns whether a connection was removed.
 */
export async function deleteConnection(
  tx: Tx,
  orgId: string,
  provider: ConnectorProvider,
): Promise<boolean> {
  const removed = await tx
    .delete(providerCredential)
    .where(eq(providerCredential.provider, provider))
    .returning({ id: providerCredential.id });
  // The messaging senders go with the credential that proved their numbers (ruling AP).
  await dropTelnyxSenders(tx);
  await tx
    .delete(providerNumberRoute)
    .where(
      and(
        eq(providerNumberRoute.provider, provider),
        eq(providerNumberRoute.organizationId, orgId),
      ),
    );
  return removed.length > 0;
}

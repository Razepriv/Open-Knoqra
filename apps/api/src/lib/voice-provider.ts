import {
  type Database,
  type ProviderCredentialRow,
  providerCredential,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { FakeProvider } from '@knoqra/providers';
import { eq } from 'drizzle-orm';
import {
  browserIdentityOf,
  buildProvider,
  type ConnectorProvider,
  openConnectionSecret,
  realProvidersOn,
} from '../connectors/registry';
import type { Env } from '../env';
import type { Tenant } from './context';
import { logger } from './logger';

export type VoiceProviderChoice =
  | { kind: ConnectorProvider; connection: ProviderCredentialRow }
  | { kind: 'fake' }
  | { kind: 'none' };

export type VoiceProviderKind = 'fake' | ConnectorProvider;

export interface VoiceToken {
  provider: VoiceProviderKind;
  token: string;
  expiresAt: string;
}

/** The provider failed or refused. Carries no provider message: it may echo request details. */
export class VoiceUpstreamError extends Error {
  constructor() {
    super('The voice provider refused the request.');
    this.name = 'VoiceUpstreamError';
  }
}

type ChoiceEnv = Pick<Env, 'PROVIDER' | 'APP_ENV' | 'FAKE_WEBHOOK_SECRET'>;

/**
 * The workspace's connected provider when real providers are on and it has a connection; the fake
 * provider outside production when the fake webhook secret is set; otherwise none.
 */
export function selectVoiceProvider(
  env: ChoiceEnv,
  connection: ProviderCredentialRow | null,
): VoiceProviderChoice {
  if (realProvidersOn(env) && connection) return { kind: connection.provider, connection };
  if (env.APP_ENV !== 'production' && env.FAKE_WEBHOOK_SECRET) return { kind: 'fake' };
  return { kind: 'none' };
}

/** The workspace's one connection (RLS-scoped `tx`), or null. */
export async function loadConnection(tx: Tx): Promise<ProviderCredentialRow | null> {
  const [connection] = await tx.select().from(providerCredential).limit(1);
  return connection ?? null;
}

/** The tenant's connection (RLS-scoped `tx`), then the provider choice for it. */
export async function loadVoiceChoice(tx: Tx, env: ChoiceEnv): Promise<VoiceProviderChoice> {
  return selectVoiceProvider(env, await loadConnection(tx));
}

/** Outside production, a workspace on the fake provider gets the development starter credit. */
export function grantsStarterCredit(
  env: Pick<Env, 'APP_ENV'>,
  choice: VoiceProviderChoice,
): boolean {
  return env.APP_ENV !== 'production' && choice.kind === 'fake';
}

export async function issueFakeToken(tenant: Tenant, webhookSecret: string): Promise<VoiceToken> {
  const session = await new FakeProvider({ webhookSecret }).createClientSession({
    orgId: tenant.orgId,
    userId: tenant.userId,
  });
  return { provider: 'fake', ...session };
}

/**
 * Opens the stored secret, asks the connected provider for a short-lived browser token and
 * persists a newly created browser identity (a Telnyx telephony credential or a Plivo endpoint).
 * Throws VoiceUpstreamError on any provider failure, SecretEnvelopeError when the secret cannot be
 * opened.
 */
export async function issueVoiceToken(
  db: Database,
  env: Pick<Env, 'API_PUBLIC_ORIGIN'>,
  tenant: Tenant,
  connection: ProviderCredentialRow,
  masterKeyBase64: string,
  fetchImpl?: typeof fetch,
): Promise<VoiceToken> {
  const secret = await openConnectionSecret(connection, masterKeyBase64);
  const built = buildProvider(connection, secret, { env, fetch: fetchImpl });
  let session: { token: string; expiresAt: string };
  try {
    session = await built.provider.createClientSession({
      orgId: tenant.orgId,
      userId: tenant.userId,
    });
  } catch (error) {
    // Name only: never the message, which can carry provider-side detail.
    logger.warn('voice.token.upstream_failed', {
      orgId: tenant.orgId,
      provider: connection.provider,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    throw new VoiceUpstreamError();
  }
  const identity = browserIdentityOf(built);
  if (identity && identity !== connection.telephonyCredentialId) {
    await withTenant(db, tenant.orgId, (tx) =>
      tx
        .update(providerCredential)
        .set({ telephonyCredentialId: identity })
        .where(eq(providerCredential.id, connection.id)),
    );
  }
  return { provider: connection.provider, ...session };
}

/** The Telnyx case of `issueVoiceToken`, kept for callers that only know Telnyx. */
export function issueTelnyxToken(
  db: Database,
  tenant: Tenant,
  connection: ProviderCredentialRow,
  masterKeyBase64: string,
  fetchImpl?: typeof fetch,
): Promise<VoiceToken> {
  return issueVoiceToken(db, {}, tenant, connection, masterKeyBase64, fetchImpl);
}

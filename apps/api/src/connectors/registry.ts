import { z } from '@hono/zod-openapi';
import {
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  type ProviderCredentialRow,
} from '@knoqra/db';
import {
  type BalanceProvider,
  type NumberPurchaseProvider,
  type NumbersProvider,
  PlivoProvider,
  PROVIDERS,
  TelnyxProvider,
  type VoiceProvider,
} from '@knoqra/providers';
import type { Env } from '../env';
import { safeText } from '../lib/schemas';
import { openSecret, providerKeyAad } from '../lib/secret-envelope';

/**
 * The API half of the provider registry (`@knoqra/providers` holds the other): per provider, what a
 * workspace sends to connect, how its secret is sealed, how its provider objects are built from a
 * stored connection, and where its webhooks post.
 */

export type { ConnectorProvider };
export { CONNECTOR_PROVIDERS };

type RealProviderEnv = Pick<Env, 'PROVIDER'>;

/** Real providers run calls (`PROVIDER=connectors`, or `telnyx`, its older name). */
export function realProvidersOn(env: RealProviderEnv): boolean {
  return env.PROVIDER === 'connectors' || env.PROVIDER === 'telnyx';
}

export function isConnectorProvider(value: unknown): value is ConnectorProvider {
  return typeof value === 'string' && (CONNECTOR_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The providers a workspace may connect on this deployment. `CONNECTORS` lists them; unset, only
 * live-verified providers are offered in production and every provider elsewhere.
 */
export function offeredConnectors(env: Pick<Env, 'CONNECTORS' | 'APP_ENV'>): ConnectorProvider[] {
  if (env.CONNECTORS === undefined || env.CONNECTORS.trim() === '') {
    return CONNECTOR_PROVIDERS.filter(
      (p) => env.APP_ENV !== 'production' || PROVIDERS[p].liveVerified,
    );
  }
  const listed = new Set(env.CONNECTORS.split(',').map((p) => p.trim().toLowerCase()));
  return CONNECTOR_PROVIDERS.filter((p) => listed.has(p));
}

const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An organization id as it may appear in a webhook path. */
export const isWebhookOrgId = (value: string): boolean => ORG_ID.test(value);

/** Where a connection's webhooks post. Plivo also has an answer URL that returns call XML. */
export function webhookPaths(
  provider: ConnectorProvider,
  orgId: string,
): { events: string; answer: string | null } {
  const events = `/webhooks/${provider}/${orgId}`;
  return { events, answer: provider === 'plivo' ? `${events}/answer` : null };
}

/** `API_PUBLIC_ORIGIN` without a trailing slash, or null when unset or not an https/http origin. */
export function apiOrigin(env: Pick<Env, 'API_PUBLIC_ORIGIN'>): string | null {
  const raw = env.API_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

const callerId = safeText({ min: 1, max: 32 });

/** base64 of a 32-byte Ed25519 public key, as the Telnyx portal shows it. */
const telnyxPublicKey = z
  .string()
  .trim()
  .max(64)
  .refine((v) => {
    try {
      return atob(v).length === 32;
    } catch {
      return false;
    }
  }, 'Paste the public key from your Telnyx portal (base64)');

export const TelnyxConnectBody = z
  .object({
    apiKey: safeText({ min: 20, max: 256, trim: false }).refine(
      (v) => !/\s/.test(v),
      'The API key must not contain whitespace',
    ),
    connectionId: safeText({ min: 1, max: 64 }),
    callerIdE164: callerId,
    /** Needed for this connection's own webhook URL. Optional: without it, use the platform URL. */
    webhookPublicKey: telnyxPublicKey.optional(),
  })
  .openapi('ConnectTelnyx');

export const PlivoConnectBody = z
  .object({
    authId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{20}$/, 'The Auth ID is 20 capital letters and digits'),
    authToken: safeText({ min: 20, max: 128, trim: false }).refine(
      (v) => !/\s/.test(v),
      'The auth token must not contain whitespace',
    ),
    appId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Enter the application id from your Plivo console'),
    callerIdE164: callerId,
  })
  .openapi('ConnectPlivo');

export type TelnyxConnectInput = z.infer<typeof TelnyxConnectBody>;
export type PlivoConnectInput = z.infer<typeof PlivoConnectBody>;

export interface ConnectorFieldJson {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  hint: string;
}

/** What the Desk asks for, per provider: rendered as the connect form. */
export const CONNECTOR_FIELDS: Readonly<Record<ConnectorProvider, ConnectorFieldJson[]>> = {
  telnyx: [
    {
      name: 'apiKey',
      label: 'API key',
      secret: true,
      required: true,
      hint: 'Telnyx portal › Account settings › Keys & credentials › API keys.',
    },
    {
      name: 'connectionId',
      label: 'Credential connection id',
      secret: false,
      required: true,
      hint: 'Voice › SIP connections › your credential connection.',
    },
    {
      name: 'callerIdE164',
      label: 'Caller id',
      secret: false,
      required: true,
      hint: 'A number on this Telnyx account, with country code.',
    },
    {
      name: 'webhookPublicKey',
      label: 'Webhook public key',
      secret: false,
      required: false,
      hint: 'Keys & credentials › Public key. Needed to use this connection’s own webhook URL.',
    },
  ],
  plivo: [
    {
      name: 'authId',
      label: 'Auth ID',
      secret: false,
      required: true,
      hint: 'Plivo console › Overview.',
    },
    {
      name: 'authToken',
      label: 'Auth token',
      secret: true,
      required: true,
      hint: 'Plivo console › Overview. Plivo also signs its webhooks with it.',
    },
    {
      name: 'appId',
      label: 'Application id',
      secret: false,
      required: true,
      hint: 'Voice › Applications: an application whose answer and hangup URLs point at KNOQRA.',
    },
    {
      name: 'callerIdE164',
      label: 'Caller id',
      secret: false,
      required: true,
      hint: 'A number on this Plivo account, with country code.',
    },
  ],
};

/** A connection's provider objects, built from its opened secret. */
export type ConnectedProvider = VoiceProvider &
  NumbersProvider &
  NumberPurchaseProvider &
  BalanceProvider;

export type BuiltProvider =
  | { kind: 'telnyx'; provider: TelnyxProvider }
  | { kind: 'plivo'; provider: PlivoProvider };

/** Opens the connection's sealed secret (the Telnyx API key or the Plivo auth token). */
export function openConnectionSecret(
  connection: ProviderCredentialRow,
  masterKeyBase64: string,
): Promise<string> {
  return openSecret(
    {
      ciphertext: connection.apiKeyCiphertext,
      iv: connection.apiKeyIv,
      dekWrapped: connection.dekWrapped,
      dekIv: connection.dekIv,
      keyFingerprint: connection.keyFingerprint,
    },
    {
      masterKeyBase64,
      aad: providerKeyAad(connection.organizationId, connection.provider),
    },
  );
}

/** The provider objects for a stored connection and its opened secret. */
export function buildProvider(
  connection: ProviderCredentialRow,
  secret: string,
  opts: { env: Pick<Env, 'API_PUBLIC_ORIGIN'>; fetch?: typeof fetch },
): BuiltProvider {
  if (connection.provider === 'plivo') {
    const origin = apiOrigin(opts.env);
    const paths = webhookPaths('plivo', connection.organizationId);
    return {
      kind: 'plivo',
      provider: new PlivoProvider({
        authId: connection.accountId ?? '',
        authToken: secret,
        appId: connection.connectionId ?? '',
        endpointUsername: connection.telephonyCredentialId,
        answerUrl: origin && paths.answer ? `${origin}${paths.answer}` : null,
        hangupUrl: origin ? `${origin}${paths.events}` : null,
        fetch: opts.fetch,
      }),
    };
  }
  return {
    kind: 'telnyx',
    provider: new TelnyxProvider({
      apiKey: secret,
      connectionId: connection.connectionId ?? '',
      telephonyCredentialId: connection.telephonyCredentialId,
      callerIdE164: connection.callerIdE164,
      fetch: opts.fetch,
    }),
  };
}

/** The browser identity a session created or reused, so the caller can persist it. */
export function browserIdentityOf(built: BuiltProvider): string | null {
  return built.kind === 'plivo'
    ? built.provider.lastEndpointUsername
    : built.provider.lastTelephonyCredentialId;
}

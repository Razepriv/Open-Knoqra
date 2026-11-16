/**
 * Every real telephony provider a workspace can connect. The fake provider is not here: it is a
 * development and test stand-in, never a connector.
 */
export const PROVIDER_IDS = ['telnyx', 'plivo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCapabilities {
  /** Browser calling, in and out. */
  voice: boolean;
  /** Listing the account's numbers (Numbers › Sync). */
  numbers: boolean;
  /** Searching and ordering numbers (Numbers › Buy a number). */
  purchase: boolean;
  /** Reading the account balance (the balance poll). */
  balance: boolean;
  /** Reading per-call usage (daily reconciliation). */
  usage: boolean;
  /** SMS and WhatsApp sending. */
  messaging: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  /**
   * Whether this adapter has run against a live account. False means it is built from the
   * provider's public docs and tested only against hand-written fixtures.
   */
  liveVerified: boolean;
  /** How the provider signs its webhooks. */
  webhookSignature: 'ed25519' | 'hmac_sha256_v3';
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  telnyx: {
    id: 'telnyx',
    label: 'Telnyx',
    capabilities: {
      voice: true,
      numbers: true,
      purchase: true,
      balance: true,
      usage: true,
      messaging: true,
    },
    liveVerified: true,
    webhookSignature: 'ed25519',
  },
  plivo: {
    id: 'plivo',
    label: 'Plivo',
    capabilities: {
      voice: true,
      numbers: true,
      purchase: true,
      balance: true,
      usage: true,
      messaging: false,
    },
    liveVerified: false,
    webhookSignature: 'hmac_sha256_v3',
  },
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

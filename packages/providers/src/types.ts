import type { AttachmentKind, Result, TenDlcState, WhatsAppState } from '@knoqra/core';

export interface SessionInput {
  orgId: string;
  userId: string;
}
export interface ShortLivedVoiceCredential {
  token: string;
  expiresAt: string;
}
export interface AuthorizedCallRequest {
  orgId: string;
  from: string;
  to: string;
  idempotencyKey: string;
  /**
   * The longest the provider may keep the call up, in seconds: what the wallet can pay for when the
   * call is placed. Telnyx takes 30 to 14,400 (`time_limit_secs`), Plivo 1 to 86,400 (`time_limit`);
   * a value outside is clamped. Absent: the provider's default (4 hours on both).
   */
  timeLimitSecs?: number;
}

/** Clamps a requested call time limit to whole seconds within the provider's range. */
export function clampTimeLimit(seconds: number, min: number, max: number): number {
  if (!Number.isFinite(seconds)) return max;
  return Math.min(max, Math.max(min, Math.floor(seconds)));
}
export interface ProviderCall {
  providerCallId: string;
  state: 'queued';
}
/** ISO 8601 strings. */
export interface DateRange {
  from: string;
  to: string;
}
/** `costMicros` is integer micro-units (1 USD = 1,000,000). */
export interface ProviderUsage {
  service: 'voice' | 'sms' | 'whatsapp';
  quantity: number;
  unit: string;
  costMicros: number;
  occurredAt: string;
  /** A stable id per usage record at the provider. */
  providerRef: string;
}
export interface AuthorizedSmsRequest {
  orgId: string;
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
}
export interface AuthorizedWhatsAppRequest {
  orgId: string;
  from: string;
  to: string;
  body?: string;
  templateId?: string;
  /** An approved Meta template, sent by name and language with body parameters in order. */
  template?: WhatsAppTemplateRef;
  /** One file, fetched by the provider from `link`; `body` becomes its caption where allowed. */
  media?: OutboundMedia;
  /** The channel id (WhatsApp wamid) of the message this one replies to. */
  replyTo?: string;
  idempotencyKey: string;
}
export interface OutboundMedia {
  kind: Exclude<AttachmentKind, 'sticker'>;
  /** A public https URL the provider fetches the file from. */
  link: string;
  fileName?: string;
}
export interface AuthorizedWhatsAppReaction {
  orgId: string;
  from: string;
  to: string;
  /** The channel id (WhatsApp wamid) of the message reacted to. */
  targetChannelMessageId: string;
  /** An emoji, or empty to remove the reaction. */
  emoji: string;
  idempotencyKey: string;
}
/** A downloaded inbound file. */
export interface FetchedMedia {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** The byte length, when the provider said. */
  size: number | null;
}
export interface WhatsAppTemplateRef {
  name: string;
  language: string;
  parameters: string[];
}
export interface ProviderMessage {
  providerMessageId: string;
  state: 'queued';
}

export interface VoiceProvider {
  createClientSession(input: SessionInput): Promise<ShortLivedVoiceCredential>;
  createCall(input: AuthorizedCallRequest): Promise<ProviderCall>;
  endCall(callId: string): Promise<void>;
  fetchUsage(period: DateRange): Promise<ProviderUsage[]>;
}

export interface ProviderNumber {
  providerNumberId: string;
  e164: string;
  status: 'active' | 'pending' | 'inactive';
  capabilities: { voice: boolean; sms: boolean; mms: boolean; whatsapp: boolean };
  tenDlc: TenDlcState;
  whatsapp: WhatsAppState;
  /**
   * False when the provider's WhatsApp facts could not be read this time (an outage, not a missing
   * product): the sync then keeps the WhatsApp columns it already has. Absent means read.
   */
  whatsappSynced?: boolean;
  /** WhatsApp's display name and quality rating for a WhatsApp number, when known. */
  whatsappDetail?: { displayName: string | null; qualityRating: string | null };
}

export interface NumbersProvider {
  listNumbers(): Promise<ProviderNumber[]>;
}

export type NumberFeature = 'voice' | 'sms' | 'mms';

export interface NumberSearch {
  /** `CA` is searched on Telnyx only; the other providers search the US. */
  country: 'US' | 'CA';
  /** 3 digits. */
  areaCode?: string;
  locality?: string;
  /** 2-letter state code. */
  region?: string;
  features: NumberFeature[];
  /** At most 20. */
  limit?: number;
}

/** What to buy, and where to attach it. */
export interface NumberOrderInput {
  e164: string;
  /** The voice connection (Telnyx) or application (Plivo) to attach; null leaves it unattached. */
  connectionId: string | null;
  /** Telnyx: the messaging profile to attach. Other providers ignore it. */
  messagingProfileId?: string | null;
  /** Telnyx: a reference stored on the order and its numbers. Other providers ignore it. */
  customerReference?: string | null;
}

/** Prices are integer micro-units (1 USD = 1,000,000). */
export interface AvailableNumber {
  e164: string;
  locality: string | null;
  region: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
  upfrontMicros: number;
  monthlyMicros: number;
  currency: 'USD';
}

export interface NumberOrderResult {
  providerOrderId: string;
  status: 'pending' | 'completed' | 'failed';
  e164: string;
}

export interface NumberPurchaseProvider {
  searchAvailableNumbers(q: NumberSearch): Promise<AvailableNumber[]>;
  /** A fresh price read for exactly this number, or null when it is no longer available. */
  quoteNumber(e164: string, country?: 'US' | 'CA'): Promise<AvailableNumber | null>;
  orderNumber(input: NumberOrderInput): Promise<NumberOrderResult>;
}

/** What a release did: `released` now, or `not_found` (the provider no longer has the number). */
export type NumberReleaseResult = 'released' | 'not_found';

/**
 * Gives a number back to the provider, which stops its monthly charge. Not every provider
 * implements it: check with `canReleaseNumbers`. Other errors throw a `ProviderApiError`.
 */
export interface NumberReleaseProvider {
  releaseNumber(providerNumberId: string): Promise<NumberReleaseResult>;
}

/** Whether this provider can release numbers. */
export function canReleaseNumbers(provider: object): provider is NumberReleaseProvider {
  return typeof (provider as Partial<NumberReleaseProvider>).releaseNumber === 'function';
}

export interface ProviderBalance {
  balanceMicros: number;
  currency: 'USD';
}

export interface BalanceProvider {
  fetchBalance(): Promise<ProviderBalance>;
}

export interface MessagingProvider {
  sendSms(input: AuthorizedSmsRequest): Promise<ProviderMessage>;
  sendWhatsApp(input: AuthorizedWhatsAppRequest): Promise<ProviderMessage>;
  /** Reacts to (or, with an empty emoji, un-reacts to) a WhatsApp message. */
  sendWhatsAppReaction?(input: AuthorizedWhatsAppReaction): Promise<ProviderMessage>;
  /** Downloads an inbound WhatsApp file by its hosted URL or its media id. */
  fetchWhatsAppMedia?(input: {
    businessNumber: string;
    url?: string;
    mediaId?: string;
    maxBytes: number;
  }): Promise<FetchedMedia>;
}

export type ProviderEventType =
  | 'call.initiated'
  | 'call.ringing'
  | 'call.answered'
  | 'call.completed'
  | 'call.failed'
  | 'call.voicemail'
  | 'message.sent'
  | 'message.delivered'
  | 'message.read'
  | 'message.failed'
  | 'message.received';

export interface ProviderEvent {
  provider: string;
  externalEventId: string;
  type: ProviderEventType;
  occurredAt: string;
  resourceId: string;
  payload: Record<string, unknown>;
}

export type ParseOutcome =
  | { kind: 'event'; event: ProviderEvent; body: unknown }
  /**
   * An event the core does not model. `body` is the parsed JSON when the adapter read it, so an
   * edition's extension can handle event types the core leaves alone (see the API's
   * `ApiExtension.providerWebhook`).
   */
  | { kind: 'ignored'; eventType: string; body?: unknown };

/** Both methods work on the exact bytes received: signatures are over bytes, never decoded text. */
export interface WebhookAdapter {
  provider: string;
  verify(headers: Headers, rawBody: Uint8Array): Promise<boolean>;
  parse(rawBody: Uint8Array): Result<ParseOutcome, 'invalid_payload'>;
}

export interface AiRequest {
  purpose: 'draft' | 'brief' | 'digest';
  prompt: string;
  sources: { kind: string; ref: string; text: string }[];
  /** Aborts the model call, for example on a timeout. */
  signal?: AbortSignal;
}
export interface AiResult {
  text: string;
  citations: string[];
  usage: { inputTokens: number; outputTokens: number };
}
export interface AiProvider {
  complete(req: AiRequest): Promise<AiResult>;
  /**
   * Like `complete`, but hands each piece of text to `onText` as the model writes it. The result is
   * the whole answer, the same as `complete` would return. Optional: without it, callers use
   * `complete` and get the text in one piece.
   */
  stream?(req: AiRequest, onText: (delta: string) => void): Promise<AiResult>;
}

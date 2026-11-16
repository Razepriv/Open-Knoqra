import type { Result, TenDlcState, WhatsAppState } from '@knoqra/core';

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
  idempotencyKey: string;
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
}

export interface NumbersProvider {
  listNumbers(): Promise<ProviderNumber[]>;
}

export type NumberFeature = 'voice' | 'sms' | 'mms';

export interface NumberSearch {
  country: 'US';
  /** 3 digits. */
  areaCode?: string;
  locality?: string;
  /** 2-letter state code. */
  region?: string;
  features: NumberFeature[];
  /** At most 20. */
  limit?: number;
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
  quoteNumber(e164: string): Promise<AvailableNumber | null>;
  orderNumber(input: { e164: string; connectionId: string | null }): Promise<NumberOrderResult>;
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
  | { kind: 'ignored'; eventType: string };

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
}
export interface AiResult {
  text: string;
  citations: string[];
  usage: { inputTokens: number; outputTokens: number };
}
export interface AiProvider {
  complete(req: AiRequest): Promise<AiResult>;
}

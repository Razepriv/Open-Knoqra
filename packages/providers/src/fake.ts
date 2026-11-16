import {
  type CallSignal,
  err,
  FAKE_PROVIDER_BALANCE_MICROS,
  HANGUP_CAUSES,
  type HangupCause,
  ok,
  type Result,
} from '@knoqra/core';
import { z } from 'zod';
import type { EventNormalizer, NormalizedEvent } from './events';
import { isMessageEventType, parseMessagePayload } from './messaging';
import { assertUsE164, clampLimit, validateSearch } from './number-input';
import type {
  AuthorizedCallRequest,
  AuthorizedSmsRequest,
  AuthorizedWhatsAppRequest,
  AvailableNumber,
  BalanceProvider,
  DateRange,
  MessagingProvider,
  NumberOrderResult,
  NumberPurchaseProvider,
  NumberSearch,
  NumbersProvider,
  ParseOutcome,
  ProviderBalance,
  ProviderCall,
  ProviderEvent,
  ProviderEventType,
  ProviderMessage,
  ProviderNumber,
  ProviderUsage,
  SessionInput,
  ShortLivedVoiceCredential,
  VoiceProvider,
  WebhookAdapter,
} from './types';

const SIGNATURE_HEADER = 'x-fake-signature';
const SESSION_TTL_MS = 10 * 60 * 1000;
const SCENARIO_START = Date.parse('2026-11-11T10:00:00Z');

const eventTypeSchema = z.enum([
  'call.initiated',
  'call.ringing',
  'call.answered',
  'call.completed',
  'call.failed',
  'call.voicemail',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'message.received',
]);

const bodySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  resource_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

const callPayloadSchema = z.object({
  client_state: z.string().optional(),
  direction: z.enum(['outgoing', 'outbound', 'incoming', 'inbound']),
  from: z.string().min(1),
  to: z.string().min(1),
  hangup_cause: z.enum(HANGUP_CAUSES).optional(),
  billable_seconds: z.number().int().nonnegative().optional(),
  org_id: z.string().min(1).optional(),
  duration_seconds: z.number().int().nonnegative().optional(),
  transcript: z.string().optional(),
});

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export type FakeOutboundScenario = 'answered' | 'busy' | 'no_answer' | 'failed';

/** The fake provider decides how an outbound call ends from the destination's last four digits. */
export function fakeOutboundScenario(toE164: string): FakeOutboundScenario {
  switch (toE164.slice(-4)) {
    case '0190':
      return 'busy';
    case '0191':
      return 'no_answer';
    case '0192':
      return 'failed';
    default:
      return 'answered';
  }
}

/** Builds a fake webhook body (unsigned) for the dev endpoint and the simulate script. */
export function buildFakeCallEvent(input: {
  type: ProviderEventType;
  providerCallId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}): { body: string } {
  return {
    body: JSON.stringify({
      id: `fake_ev_${crypto.randomUUID().replaceAll('-', '')}`,
      type: input.type,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      resource_id: input.providerCallId,
      payload: input.payload,
    }),
  };
}

const hangup = (cause: HangupCause): CallSignal => ({ type: 'hangup', cause });

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string): Uint8Array | null => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Constant-time for equal-length inputs; length mismatch returns false. */
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

const importHmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

const FAKE_NUMBERS: readonly ProviderNumber[] = [
  {
    providerNumberId: 'fake_num_100',
    e164: '+12025550100',
    status: 'active',
    capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
    tenDlc: 'registered',
    whatsapp: 'none',
  },
  {
    providerNumberId: 'fake_num_101',
    e164: '+12025550101',
    status: 'active',
    capabilities: { voice: true, sms: false, mms: false, whatsapp: false },
    tenDlc: 'not_required',
    whatsapp: 'none',
  },
  {
    providerNumberId: 'fake_num_102',
    e164: '+12025550102',
    status: 'active',
    capabilities: { voice: false, sms: true, mms: true, whatsapp: true },
    tenDlc: 'pending',
    whatsapp: 'pending',
  },
];

const FAKE_DEFAULT_AREA_CODE = '202';
const FAKE_PRICE_MICROS = 1_000_000;
const FAKE_FAILING_SUFFIX = '0159';
/** Every fake order id starts with this, so a caller can tell the fake's own orders apart. */
export const FAKE_ORDER_ID_PREFIX = 'fake_order_';

function fakeListing(areaCode: string): AvailableNumber[] {
  const count = areaCode === FAKE_DEFAULT_AREA_CODE ? 10 : 5;
  return Array.from({ length: count }, (_, i) => ({
    e164: `+1${areaCode}5550${150 + i}`,
    locality: null,
    region: null,
    capabilities: { voice: true, sms: true, mms: true },
    upfrontMicros: FAKE_PRICE_MICROS,
    monthlyMicros: FAKE_PRICE_MICROS,
    currency: 'USD' as const,
  }));
}

export class FakeProvider
  implements
    VoiceProvider,
    MessagingProvider,
    NumbersProvider,
    NumberPurchaseProvider,
    BalanceProvider,
    WebhookAdapter,
    EventNormalizer
{
  readonly provider = 'fake';
  readonly calls: AuthorizedCallRequest[] = [];
  readonly messages: (AuthorizedSmsRequest | AuthorizedWhatsAppRequest)[] = [];

  private callSeq = 0;
  private msgSeq = 0;
  private tokenSeq = 0;
  private readonly key: ReturnType<typeof importHmacKey>;

  private readonly messageIdFactory: (() => string) | undefined;
  private readonly balanceMicros: number;
  private readonly usage: readonly ProviderUsage[];
  private readonly ordered: readonly string[];
  private orderSeq = 0;

  constructor(opts: {
    webhookSecret: string;
    messageIdFactory?: () => string;
    balanceMicros?: number;
    usage?: ProviderUsage[];
    /** E.164 numbers bought earlier; they appear in `listNumbers` as active. */
    ordered?: string[];
  }) {
    if (opts.webhookSecret.length === 0) {
      throw new Error('FakeProvider: webhookSecret must be non-empty');
    }
    this.key = importHmacKey(opts.webhookSecret);
    this.messageIdFactory = opts.messageIdFactory;
    this.balanceMicros = opts.balanceMicros ?? FAKE_PROVIDER_BALANCE_MICROS;
    this.usage = opts.usage ?? [];
    this.ordered = opts.ordered ?? [];
  }

  async searchAvailableNumbers(q: NumberSearch): Promise<AvailableNumber[]> {
    validateSearch(q);
    return fakeListing(q.areaCode ?? FAKE_DEFAULT_AREA_CODE).slice(0, clampLimit(q.limit));
  }

  async quoteNumber(e164: string): Promise<AvailableNumber | null> {
    assertUsE164(e164);
    if (this.ordered.includes(e164)) return null;
    return fakeListing(e164.slice(2, 5)).find((n) => n.e164 === e164) ?? null;
  }

  async orderNumber(input: {
    e164: string;
    connectionId: string | null;
  }): Promise<NumberOrderResult> {
    assertUsE164(input.e164);
    this.orderSeq += 1;
    const listed =
      !this.ordered.includes(input.e164) &&
      fakeListing(input.e164.slice(2, 5)).some((n) => n.e164 === input.e164);
    return {
      providerOrderId: `${FAKE_ORDER_ID_PREFIX}${this.orderSeq}`,
      status: listed && !input.e164.endsWith(FAKE_FAILING_SUFFIX) ? 'completed' : 'failed',
      e164: input.e164,
    };
  }

  async createClientSession(_input: SessionInput): Promise<ShortLivedVoiceCredential> {
    this.tokenSeq += 1;
    return {
      token: `fake_token_${this.tokenSeq}`,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
  }

  async createCall(input: AuthorizedCallRequest): Promise<ProviderCall> {
    this.callSeq += 1;
    this.calls.push(input);
    return { providerCallId: `fake_call_${this.callSeq}`, state: 'queued' };
  }

  async endCall(_callId: string): Promise<void> {}

  async fetchUsage(period: DateRange): Promise<ProviderUsage[]> {
    const from = Date.parse(period.from);
    const to = Date.parse(period.to);
    return this.usage.filter((u) => {
      const at = Date.parse(u.occurredAt);
      return at >= from && at < to;
    });
  }

  async fetchBalance(): Promise<ProviderBalance> {
    return { balanceMicros: this.balanceMicros, currency: 'USD' };
  }

  async listNumbers(): Promise<ProviderNumber[]> {
    const fixed = FAKE_NUMBERS.map((n) => ({ ...n, capabilities: { ...n.capabilities } }));
    const bought: ProviderNumber[] = this.ordered.map((e164) => ({
      providerNumberId: `fake_ord_${e164.replace(/\D/g, '')}`,
      e164,
      status: 'active',
      capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
      tenDlc: 'none',
      whatsapp: 'none',
    }));
    return [...fixed, ...bought];
  }

  async sendSms(input: AuthorizedSmsRequest): Promise<ProviderMessage> {
    return this.record(input);
  }

  async sendWhatsApp(input: AuthorizedWhatsAppRequest): Promise<ProviderMessage> {
    return this.record(input);
  }

  private record(input: AuthorizedSmsRequest | AuthorizedWhatsAppRequest): ProviderMessage {
    this.msgSeq += 1;
    this.messages.push(input);
    return {
      providerMessageId: this.messageIdFactory?.() ?? `fake_msg_${this.msgSeq}`,
      state: 'queued',
    };
  }

  async signWebhook(rawBody: Uint8Array | string): Promise<string> {
    const bytes = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
    const sig = await crypto.subtle.sign('HMAC', await this.key, bytes);
    return toHex(new Uint8Array(sig));
  }

  async verify(headers: Headers, rawBody: Uint8Array): Promise<boolean> {
    const header = headers.get(SIGNATURE_HEADER);
    if (header === null) return false;
    const provided = fromHex(header);
    if (provided === null) return false;
    const expected = fromHex(await this.signWebhook(rawBody));
    return expected !== null && timingSafeEqual(provided, expected);
  }

  parse(rawBody: Uint8Array): Result<ParseOutcome, 'invalid_payload'> {
    let json: unknown;
    try {
      json = JSON.parse(strictDecoder.decode(rawBody));
    } catch {
      return err('invalid_payload');
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) return err('invalid_payload');
    const b = parsed.data;
    const type = eventTypeSchema.safeParse(b.type);
    if (!type.success) return ok({ kind: 'ignored', eventType: b.type });
    return ok({
      kind: 'event',
      event: {
        provider: this.provider,
        externalEventId: b.id,
        type: type.data,
        occurredAt: b.occurred_at,
        resourceId: b.resource_id,
        payload: b.payload,
      },
      body: json,
    });
  }

  normalize(body: unknown): NormalizedEvent | null {
    const envelope = bodySchema.safeParse(body);
    if (!envelope.success) return null;
    const { type, resource_id: providerCallId, occurred_at: occurredAt } = envelope.data;
    if (isMessageEventType(type)) return this.normalizeMessage(envelope.data);
    if (!type.startsWith('call.')) return null;
    const payload = callPayloadSchema.safeParse(envelope.data.payload);
    if (!payload.success) return null;
    const p = payload.data;
    const direction = p.direction.startsWith('in') ? 'inbound' : 'outbound';
    const signal = this.signalFor(type, direction, p.hangup_cause);
    if (signal === null) return null;
    const isVoicemail = type === 'call.voicemail';
    return {
      kind: 'call',
      provider: this.provider,
      providerCallId,
      clientState: p.client_state ?? null,
      signal,
      direction,
      from: p.from,
      to: p.to,
      occurredAt,
      billableSeconds: p.billable_seconds ?? null,
      voicemail: isVoicemail
        ? { durationSeconds: p.duration_seconds ?? 0, transcript: p.transcript ?? null }
        : null,
      orgHint: direction === 'inbound' ? (p.org_id ?? null) : null,
    };
  }

  /** `null` for an unknown message type or a payload that fails validation (nothing to apply). */
  private normalizeMessage(body: z.infer<typeof bodySchema>): NormalizedEvent | null {
    const type = eventTypeSchema.safeParse(body.type);
    if (!type.success) return null;
    const event: ProviderEvent = {
      provider: this.provider,
      externalEventId: body.id,
      type: type.data,
      occurredAt: body.occurred_at,
      resourceId: body.resource_id,
      payload: body.payload,
    };
    const payload = parseMessagePayload(event);
    if (!payload.ok) return null;
    return { kind: 'message', provider: this.provider, event, payload: payload.value };
  }

  private signalFor(
    type: string,
    direction: 'outbound' | 'inbound',
    cause: HangupCause | undefined,
  ): CallSignal | null {
    switch (type) {
      case 'call.initiated':
        return { type: direction === 'outbound' ? 'dialing' : 'ringing' };
      case 'call.ringing':
        return { type: 'ringing' };
      case 'call.answered':
        return { type: 'answered' };
      case 'call.completed':
        return hangup(cause ?? 'normal');
      case 'call.failed':
        return hangup('failed');
      case 'call.voicemail':
        return hangup('no_answer');
      default:
        return null;
    }
  }

  scenario(name: 'outbound-answered', callId: string): ProviderEvent[] {
    const types = ['call.initiated', 'call.ringing', 'call.answered', 'call.completed'] as const;
    return types.map((type, i) => ({
      provider: this.provider,
      externalEventId: `${name}_${callId}_${i + 1}`,
      type,
      occurredAt: new Date(SCENARIO_START + i * 1000).toISOString(),
      resourceId: callId,
      payload: { direction: 'outgoing', from: '+12025550100', to: '+12025550123' },
    }));
  }
}

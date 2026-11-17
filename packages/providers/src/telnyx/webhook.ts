import { err, ok, type Result } from '@knoqra/core';
import type { EventNormalizer, NormalizedEvent } from '../events';
import type { ParseOutcome, ProviderEvent, ProviderEventType, WebhookAdapter } from '../types';
import { base64ToBytes } from './base64';
import {
  normalizeTelnyxMessage,
  TELNYX_MESSAGE_EVENT_TYPES,
  type TelnyxMessageEvent,
} from './messaging-normalize';
import {
  envelopeSchema,
  MODELED_EVENT_TYPES,
  normalizeTelnyx,
  parseCallPayload,
  TELNYX_PROVIDER,
} from './normalize';

type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const SIGNATURE_HEADER = 'telnyx-signature-ed25519';
const TIMESTAMP_HEADER = 'telnyx-timestamp';
const DEFAULT_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const EVENT_TYPE: Record<(typeof MODELED_EVENT_TYPES)[number], ProviderEventType> = {
  'call.initiated': 'call.initiated',
  'call.answered': 'call.answered',
  'call.hangup': 'call.completed',
  'call.machine.detection.ended': 'call.voicemail',
};

const isModeled = (type: string): type is (typeof MODELED_EVENT_TYPES)[number] =>
  (MODELED_EVENT_TYPES as readonly string[]).includes(type);

const isMessageType = (type: string): boolean =>
  (TELNYX_MESSAGE_EVENT_TYPES as readonly string[]).includes(type);

/** A message webhook as a provider event: the resource is the Telnyx message id. */
const messageEvent = (message: TelnyxMessageEvent): ProviderEvent => ({
  provider: TELNYX_PROVIDER,
  externalEventId: message.externalEventId,
  type: message.type,
  occurredAt: message.occurredAt,
  resourceId: message.providerMessageId,
  payload: { ...message.payload },
});

export interface TelnyxWebhookAdapterOptions {
  publicKeyBase64: string;
  /** Maximum |now - timestamp| in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Current time in epoch milliseconds. */
  now?: () => number;
}

export class TelnyxWebhookAdapter implements WebhookAdapter, EventNormalizer {
  readonly provider = TELNYX_PROVIDER;
  private readonly tolerance: number;
  private readonly now: () => number;
  private readonly key: Promise<ImportedKey | null>;

  constructor(opts: TelnyxWebhookAdapterOptions) {
    this.tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.now = opts.now ?? Date.now;
    this.key = importKey(opts.publicKeyBase64);
  }

  async verify(headers: Headers, rawBody: Uint8Array): Promise<boolean> {
    const signatureText = headers.get(SIGNATURE_HEADER);
    const timestampText = headers.get(TIMESTAMP_HEADER);
    if (signatureText === null || timestampText === null) return false;
    if (!/^\d{1,12}$/.test(timestampText)) return false;
    if (Math.abs(this.now() / 1000 - Number(timestampText)) > this.tolerance) return false;
    const signature = base64ToBytes(signatureText);
    const key = await this.key;
    if (signature === null || key === null) return false;
    const prefix = encoder.encode(`${timestampText}|`);
    const message = new Uint8Array(prefix.length + rawBody.length);
    message.set(prefix, 0);
    message.set(rawBody, prefix.length);
    try {
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
    } catch {
      return false;
    }
  }

  parse(rawBody: Uint8Array): Result<ParseOutcome, 'invalid_payload'> {
    let json: unknown;
    try {
      json = JSON.parse(strictDecoder.decode(rawBody));
    } catch {
      return err('invalid_payload');
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) return err('invalid_payload');
    const { id, event_type: eventType, occurred_at: occurredAt, payload } = envelope.data.data;
    if (isMessageType(eventType)) {
      // normalizeTelnyxMessage returns null both for a message event M3 does not track (MMS media
      // only, a non-final status) and for a malformed message payload. Either is acknowledged and
      // dropped (200 ignored), like any other event this adapter does not model, so Telnyx does
      // not retry a body we would never apply.
      const message = normalizeTelnyxMessage(json);
      if (message === null) return ok({ kind: 'ignored', eventType });
      return ok({ kind: 'event', event: messageEvent(message), body: json });
    }
    if (!isModeled(eventType)) return ok({ kind: 'ignored', eventType, body: json });
    const call = parseCallPayload(payload);
    if (call === null) return err('invalid_payload');
    return ok({
      kind: 'event',
      event: {
        provider: this.provider,
        externalEventId: id,
        type: EVENT_TYPE[eventType],
        occurredAt,
        resourceId: call.call_control_id,
        payload,
      },
      body: json,
    });
  }

  normalize(body: unknown): NormalizedEvent | null {
    const message = normalizeTelnyxMessage(body);
    if (message !== null) {
      return {
        kind: 'message',
        provider: TELNYX_PROVIDER,
        event: messageEvent(message),
        payload: message.payload,
      };
    }
    return normalizeTelnyx(body);
  }
}

async function importKey(publicKeyBase64: string): Promise<ImportedKey | null> {
  const raw = base64ToBytes(publicKeyBase64);
  if (raw === null) return null;
  try {
    return await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    return null;
  }
}

import { z } from 'zod';
import type {
  AuthorizedSmsRequest,
  AuthorizedWhatsAppReaction,
  AuthorizedWhatsAppRequest,
  FetchedMedia,
  MessagingProvider,
  OutboundMedia,
  ProviderMessage,
  WhatsAppTemplateRef,
} from '../types';
import { TelnyxMessagingError } from './messaging-errors';

const DEFAULT_API_BASE = 'https://api.telnyx.com/v2';
/** Telnyx accepts an `Idempotency-Key` of 1–255 letters, digits, hyphens or underscores. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,255}$/;
/** Both docs examples pin the template language with the `deterministic` policy. */
const TEMPLATE_LANGUAGE_POLICY = 'deterministic';

/** `POST /messages` and `POST /messages/whatsapp` both answer `{ data: { id, ... } }`. */
const sendResponseSchema = z.object({ data: z.object({ id: z.string().min(1).max(128) }) });
/** `GET /phone_numbers` answers `{ data: [{ phone_number, status, ... }], meta }`. */
const phoneNumbersSchema = z.object({
  data: z.array(z.object({ phone_number: z.string(), status: z.string().optional() })),
});
/**
 * The statuses of a number the account currently controls (ruling AO). An allowlist: a pending,
 * failed, deleted, ported-out, emergency-only or requirement-info number, an unknown status and a
 * missing status are all not owned. A number mid port-out is still the account's until it leaves.
 */
const OWNED_NUMBER_STATUSES: ReadonlySet<string> = new Set(['active', 'port-out-pending']);
/** How long the ownership check waits for Telnyx before giving up. */
const DEFAULT_OWNERSHIP_TIMEOUT_MS = 10_000;
/** How long a send waits for Telnyx before giving up. */
const DEFAULT_SEND_TIMEOUT_MS = 15_000;
/** How long an inbound media download may take to start answering. */
const DEFAULT_MEDIA_TIMEOUT_MS = 30_000;
/** WhatsApp caps captions at 1024 bytes; longer text is cut on a character boundary. */
const MAX_CAPTION_BYTES = 1024;
/** Media kinds WhatsApp lets carry a caption. */
const CAPTIONED: ReadonlySet<OutboundMedia['kind']> = new Set(['image', 'video', 'document']);
const E164 = /^\+[1-9]\d{6,14}$/;
const errorBodySchema = z.object({
  errors: z.array(z.object({ code: z.union([z.string(), z.number()]) })).min(1),
});

export interface TelnyxMessagingProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
  /** The ownership check's time limit; tests shorten it. */
  ownershipTimeoutMs?: number;
  /** The send requests' time limit; tests shorten it. */
  sendTimeoutMs?: number;
  /** The media download's time limit; tests shorten it. */
  mediaTimeoutMs?: number;
}

/** Sends SMS and WhatsApp messages through Telnyx's v2 messaging API. */
export class TelnyxMessagingProvider implements MessagingProvider {
  readonly #apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly ownershipTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly mediaTimeoutMs: number;

  constructor(opts: TelnyxMessagingProviderOptions) {
    this.#apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.ownershipTimeoutMs = opts.ownershipTimeoutMs ?? DEFAULT_OWNERSHIP_TIMEOUT_MS;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.mediaTimeoutMs = opts.mediaTimeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  }

  async sendSms(input: AuthorizedSmsRequest): Promise<ProviderMessage> {
    return this.send('/messages', input.idempotencyKey, {
      from: input.from,
      to: input.to,
      text: input.body,
    });
  }

  /**
   * A template wins over everything: a template send never falls back to free text. Otherwise one
   * file (with `body` as its caption where WhatsApp allows one) or the text. `replyTo` quotes a
   * message by its wamid (`context.message_id`, Telnyx's "Reply Context" guide).
   */
  async sendWhatsApp(input: AuthorizedWhatsAppRequest): Promise<ProviderMessage> {
    const content: Record<string, unknown> | null =
      input.template !== undefined
        ? templateMessage(input.template)
        : input.media !== undefined
          ? mediaMessage(input.media, input.body)
          : input.body !== undefined
            ? { type: 'text', text: { body: input.body } }
            : null;
    if (content === null) throw new Error('WhatsApp send needs a body, a file or a template');
    const whatsappMessage =
      input.replyTo !== undefined && input.template === undefined
        ? { ...content, context: { message_id: input.replyTo } }
        : content;
    return this.send('/messages/whatsapp', input.idempotencyKey, {
      from: input.from,
      to: input.to,
      whatsapp_message: whatsappMessage,
    });
  }

  /** `{ type: 'reaction', reaction: { message_id, emoji } }`; an empty emoji removes it (Meta's rule). */
  async sendWhatsAppReaction(input: AuthorizedWhatsAppReaction): Promise<ProviderMessage> {
    return this.send('/messages/whatsapp', input.idempotencyKey, {
      from: input.from,
      to: input.to,
      whatsapp_message: {
        type: 'reaction',
        reaction: { message_id: input.targetChannelMessageId, emoji: input.emoji },
      },
    });
  }

  /**
   * Downloads an inbound WhatsApp file: the Telnyx-hosted `url` when the webhook carried one,
   * otherwise `GET /whatsapp/media/{business_number}/{media_id}`, which answers the raw bytes with
   * their MIME type. Both are requested with the key (harmless if the URL is public). Throws a
   * TelnyxMessagingError (status and code only) on a non-200, a timeout, or a file over `maxBytes`.
   */
  async fetchWhatsAppMedia(input: {
    businessNumber: string;
    url?: string;
    mediaId?: string;
    maxBytes: number;
  }): Promise<FetchedMedia> {
    const target =
      input.url !== undefined
        ? input.url
        : input.mediaId !== undefined && E164.test(input.businessNumber)
          ? `${this.apiBase}/whatsapp/media/${encodeURIComponent(input.businessNumber)}/${encodeURIComponent(input.mediaId)}`
          : null;
    if (target === null || !/^https:\/\//.test(target)) {
      throw new TelnyxMessagingError(0, 'invalid_media_reference');
    }
    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.mediaTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new TelnyxMessagingError(0, timedOut ? 'timeout' : 'network_error');
    }
    if (res.status !== 200 || res.body === null) {
      throw new TelnyxMessagingError(
        res.status,
        res.status === 200 ? 'empty_body' : await errorCode(res),
      );
    }
    const length = Number(res.headers.get('content-length'));
    const size = Number.isFinite(length) && length > 0 ? length : null;
    if (size !== null && size > input.maxBytes) {
      await res.body.cancel();
      throw new TelnyxMessagingError(413, 'media_too_large');
    }
    const contentType =
      res.headers.get('content-type')?.slice(0, 128) || 'application/octet-stream';
    return { body: res.body, contentType, size };
  }

  /**
   * Whether `e164` is a number in this API key's Telnyx account. Telnyx returns nothing for a
   * filter with non-numerical characters, so the digits are sent and every listed `phone_number`
   * is compared to the number exactly (the filter may match more than one). Only an `active` or
   * `port-out-pending` number counts (ruling AO). Throws a TelnyxMessagingError (status and code
   * only) on any non-200; a request Telnyx does not answer within the time limit throws status 0,
   * code `timeout`.
   */
  async ownsNumber(e164: string): Promise<boolean> {
    if (!E164.test(e164)) return false;
    const query = new URLSearchParams({ 'filter[phone_number]': e164.slice(1) });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}/phone_numbers?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.ownershipTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      throw new TelnyxMessagingError(0, timedOut ? 'timeout' : 'network_error');
    }
    if (res.status !== 200) throw new TelnyxMessagingError(res.status, await errorCode(res));
    let parsed: z.infer<typeof phoneNumbersSchema>;
    try {
      parsed = phoneNumbersSchema.parse(await res.json());
    } catch {
      throw new TelnyxMessagingError(res.status, 'invalid_response');
    }
    return parsed.data.some(
      (n) =>
        n.phone_number === e164 && n.status !== undefined && OWNED_NUMBER_STATUSES.has(n.status),
    );
  }

  private async send(
    path: string,
    idempotencyKey: string,
    body: Record<string, unknown>,
  ): Promise<ProviderMessage> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      'content-type': 'application/json',
    };
    if (IDEMPOTENCY_KEY.test(idempotencyKey)) headers['idempotency-key'] = idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.sendTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        // Telnyx may have accepted the message before the limit, so a blind retry could send twice.
        throw new TelnyxMessagingError(0, 'timeout', {
          code: 'provider_error',
          message:
            'Your phone provider did not answer in time. The message may still have been sent.',
          retryable: false,
        });
      }
      throw new TelnyxMessagingError(0, 'network_error');
    }
    if (!res.ok) throw new TelnyxMessagingError(res.status, await errorCode(res));

    let parsed: z.infer<typeof sendResponseSchema>;
    try {
      parsed = sendResponseSchema.parse(await res.json());
    } catch {
      // Telnyx may have accepted the message, so a blind retry could send it twice.
      throw new TelnyxMessagingError(res.status, 'invalid_response', {
        code: 'provider_error',
        message: 'Your phone provider sent an unreadable response.',
        retryable: false,
      });
    }
    return { providerMessageId: parsed.data.id, state: 'queued' };
  }
}

/** Cuts UTF-8 text to `max` bytes without splitting a character. */
function capBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (used + size > max) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * One file (Telnyx's `WhatsappMedia`: `link`, `caption`, `filename`, `voice`). A voice note is sent
 * as `audio` with `voice: true` (OGG/Opus, Meta's rule); captions only on images, videos and
 * documents.
 */
function mediaMessage(media: OutboundMedia, body: string | undefined): Record<string, unknown> {
  const type = media.kind === 'voice' ? 'audio' : media.kind;
  const caption =
    body?.trim() && CAPTIONED.has(media.kind)
      ? capBytes(body.trim(), MAX_CAPTION_BYTES)
      : undefined;
  return {
    type,
    [type]: {
      link: media.link,
      ...(caption ? { caption } : {}),
      ...(media.kind === 'document' && media.fileName ? { filename: media.fileName } : {}),
      ...(media.kind === 'voice' ? { voice: true } : {}),
    },
  };
}

function templateMessage(template: WhatsAppTemplateRef) {
  const components =
    template.parameters.length === 0
      ? undefined
      : [
          {
            type: 'body',
            parameters: template.parameters.map((text) => ({ type: 'text', text })),
          },
        ];
  return {
    type: 'template',
    template: {
      name: template.name,
      language: { policy: TEMPLATE_LANGUAGE_POLICY, code: template.language },
      ...(components === undefined ? {} : { components }),
    },
  };
}

/** The first `errors[].code`, or `unknown`. The body itself is never kept. */
async function errorCode(res: Response): Promise<string> {
  try {
    const parsed = errorBodySchema.safeParse(await res.json());
    return parsed.success ? String(parsed.data.errors[0]?.code ?? 'unknown') : 'unknown';
  } catch {
    return 'unknown';
  }
}

import { z } from 'zod';
import type {
  AuthorizedSmsRequest,
  AuthorizedWhatsAppRequest,
  MessagingProvider,
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
}

/** Sends SMS and WhatsApp messages through Telnyx's v2 messaging API. */
export class TelnyxMessagingProvider implements MessagingProvider {
  readonly #apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly ownershipTimeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(opts: TelnyxMessagingProviderOptions) {
    this.#apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = opts.apiBase ?? DEFAULT_API_BASE;
    this.ownershipTimeoutMs = opts.ownershipTimeoutMs ?? DEFAULT_OWNERSHIP_TIMEOUT_MS;
    this.sendTimeoutMs = opts.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  }

  async sendSms(input: AuthorizedSmsRequest): Promise<ProviderMessage> {
    return this.send('/messages', input.idempotencyKey, {
      from: input.from,
      to: input.to,
      text: input.body,
    });
  }

  /** A template wins over `body`: a template send never falls back to free text. */
  async sendWhatsApp(input: AuthorizedWhatsAppRequest): Promise<ProviderMessage> {
    const whatsappMessage =
      input.template !== undefined
        ? templateMessage(input.template)
        : input.body !== undefined
          ? { type: 'text', text: { body: input.body } }
          : null;
    if (whatsappMessage === null) throw new Error('WhatsApp send needs a body or a template');
    return this.send('/messages/whatsapp', input.idempotencyKey, {
      from: input.from,
      to: input.to,
      whatsapp_message: whatsappMessage,
    });
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
          message: 'Telnyx did not answer in time. The message may still have been sent.',
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
        message: 'Telnyx sent an unreadable response.',
        retryable: false,
      });
    }
    return { providerMessageId: parsed.data.id, state: 'queued' };
  }
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

import { err, ok, type Result } from '@knoqra/core';
import type { EventNormalizer, NormalizedEvent } from '../events';
import type { ParseOutcome, WebhookAdapter } from '../types';
import { formFields } from './form';
import { classifyPlivo, normalizePlivo, PLIVO_PROVIDER, RECEIVED_AT_FIELD } from './normalize';
import { verifyPlivoV3 } from './signature';

export interface PlivoWebhookAdapterOptions {
  /** The connection's auth token: Plivo signs each callback with it. */
  authToken: string;
  /** The exact URL Plivo posted to: the signature covers it. */
  url: string;
  /** Current time in epoch milliseconds. */
  now?: () => number;
}

/**
 * Plivo callbacks: form-encoded POSTs signed with `X-Plivo-Signature-V3`. One adapter per request,
 * because the signature covers the URL. Plivo sends no timestamp, so a replay with the same body
 * verifies; the store's unique external id makes a replayed event a duplicate.
 */
export class PlivoWebhookAdapter implements WebhookAdapter, EventNormalizer {
  readonly provider = PLIVO_PROVIDER;
  private readonly authToken: string;
  private readonly url: string;
  private readonly now: () => number;

  constructor(opts: PlivoWebhookAdapterOptions) {
    this.authToken = opts.authToken;
    this.url = opts.url;
    this.now = opts.now ?? Date.now;
  }

  verify(headers: Headers, rawBody: Uint8Array): Promise<boolean> {
    return verifyPlivoV3({ url: this.url, headers, authToken: this.authToken, body: rawBody });
  }

  parse(rawBody: Uint8Array): Result<ParseOutcome, 'invalid_payload'> {
    const fields = formFields(rawBody);
    if (fields === null) return err('invalid_payload');
    const body = { ...fields, [RECEIVED_AT_FIELD]: new Date(this.now()).toISOString() };
    const classified = classifyPlivo(body);
    if (classified.kind === 'invalid') return err('invalid_payload');
    if (classified.kind === 'ignored')
      return ok({ kind: 'ignored', eventType: classified.eventType });
    const { fact } = classified;
    return ok({
      kind: 'event',
      event: {
        provider: this.provider,
        externalEventId: fact.externalEventId,
        type: fact.type,
        occurredAt: fact.occurredAt,
        resourceId: fact.callUuid,
        payload: body,
      },
      body,
    });
  }

  normalize(body: unknown): NormalizedEvent | null {
    return normalizePlivo(body);
  }
}

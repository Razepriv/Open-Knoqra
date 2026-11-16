import type { Database } from '@knoqra/db';
import {
  type EventNormalizer,
  FakeProvider,
  type NormalizedEvent,
  PlivoWebhookAdapter,
  TelnyxWebhookAdapter,
} from '@knoqra/providers';
import type { Env } from '../env';
import { handleMessageEvent } from '../messaging/ingest';
import { handleCallEvent } from './call-handler';

export interface HandlerContext {
  env: Env;
  db: Database;
  rawEventId: string;
  /**
   * The organization whose own key verified this delivery (a per-connection webhook URL), or null
   * for the platform URL. A handler must not apply such an event to any other organization.
   */
  connectorOrgId: string | null;
  /** Tests only: the fetch provider clients use after commit (inbound file downloads). */
  fetch?: typeof fetch;
}

/**
 * `processed`: the event is applied and its raw row committed as processed; `after` runs the
 * best-effort side effects (lock release, realtime). `parked`: nothing was applied, and a provider
 * redelivery may try again. `ignored`: nothing was applied and nothing ever will be (for example a
 * message to an address with no route); the row is final.
 */
export type HandlerResult =
  | { status: 'processed'; after: () => Promise<void> }
  | { status: 'parked'; reason: string }
  | { status: 'ignored'; reason: string };

export type EventHandler<K extends NormalizedEvent['kind']> = (
  ctx: HandlerContext,
  event: Extract<NormalizedEvent, { kind: K }>,
) => Promise<HandlerResult>;

/** One handler per event kind: calls (M2) and messages (M3). */
export const handlers: { [K in NormalizedEvent['kind']]: EventHandler<K> } = {
  call: handleCallEvent,
  message: handleMessageEvent,
};

export function dispatch(ctx: HandlerContext, event: NormalizedEvent): Promise<HandlerResult> {
  switch (event.kind) {
    case 'call':
      return handlers.call(ctx, event);
    case 'message':
      return handlers.message(ctx, event);
  }
}

/**
 * Normalization reads only the stored body, so it needs no secrets: the signature was checked at
 * ingest. The constructor arguments below are never used to verify anything here.
 */
const NORMALIZE_ONLY = 'normalize-only';

export function normalizerFor(provider: string, _env: Env): EventNormalizer | null {
  switch (provider) {
    case 'fake':
      return new FakeProvider({ webhookSecret: NORMALIZE_ONLY });
    case 'telnyx':
      return new TelnyxWebhookAdapter({ publicKeyBase64: '' });
    case 'plivo':
      return new PlivoWebhookAdapter({ authToken: '', url: '' });
    default:
      return null;
  }
}

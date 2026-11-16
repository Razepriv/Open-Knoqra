import type { CallSignal } from '@knoqra/core';
import type { MessageEventPayload } from './messaging';
import type { ProviderEvent } from './types';

/** A call lifecycle fact, independent of which provider reported it. */
export type NormalizedCallEvent = {
  kind: 'call';
  provider: string;
  providerCallId: string;
  clientState: string | null;
  signal: CallSignal;
  direction: 'outbound' | 'inbound';
  from: string;
  to: string;
  occurredAt: string;
  billableSeconds: number | null;
  voicemail: { durationSeconds: number; transcript: string | null } | null;
  orgHint: string | null;
};

/** A `message.*` fact (inbound message or delivery receipt) with its validated payload. */
export type NormalizedMessageEvent = {
  kind: 'message';
  provider: string;
  event: ProviderEvent;
  payload: MessageEventPayload;
};

export type NormalizedEvent = NormalizedCallEvent | NormalizedMessageEvent;

export interface EventNormalizer {
  provider: string;
  /** `null` means there is nothing to apply for this event. */
  normalize(body: unknown): NormalizedEvent | null;
}

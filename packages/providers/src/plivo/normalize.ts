import type { HangupCause } from '@knoqra/core';
import type { NormalizedCallEvent } from '../events';
import type { ProviderEventType } from '../types';

export const PLIVO_PROVIDER = 'plivo';

/**
 * The custom SIP header the browser SDK sends with each call (`X-PH-` + name), carrying KNOQRA's
 * random client state. Plivo passes it to the answer URL as a form field of the same name.
 */
export const CLIENT_STATE_FIELD = 'X-PH-ClientState';

/**
 * Added by KNOQRA when a callback arrives: when it was received. Plivo's own time fields are not
 * used for billing, because their time zone is not confirmed (see the fixtures README).
 */
export const RECEIVED_AT_FIELD = 'KnoqraReceivedAt';

const UUID = /^[A-Za-z0-9-]{1,64}$/;
const CLIENT_STATE = /^[0-9a-f]{32}$/;
const MAX_EVENT_TYPE = 64;

export type PlivoFields = Record<string, string>;

export interface PlivoCallFact {
  /** Unique per callback: the call's A-leg id plus which callback it is. */
  externalEventId: string;
  type: ProviderEventType;
  callUuid: string;
  clientState: string | null;
  direction: 'inbound' | 'outbound';
  from: string;
  to: string;
  occurredAt: string;
  cause: HangupCause | null;
}

export type Classified =
  | { kind: 'call'; fact: PlivoCallFact }
  | { kind: 'ignored'; eventType: string }
  | { kind: 'invalid' };

/** Plivo's call status words (hangup and dial callbacks) to KNOQRA's causes. */
const STATUS_CAUSE: Record<string, HangupCause> = {
  completed: 'normal',
  busy: 'busy',
  'no-answer': 'no_answer',
  timeout: 'no_answer',
  cancel: 'canceled',
  failed: 'failed',
};

/** Hangup cause names that say more than the status does. */
const NAME_CAUSE: Record<string, HangupCause> = {
  'busy line': 'busy',
  'no answer': 'no_answer',
  'ring timeout reached': 'no_answer',
  rejected: 'rejected',
  'call rejected': 'rejected',
  canceled: 'canceled',
  cancelled: 'canceled',
};

export function mapPlivoCause(status: string | undefined, name: string | undefined): HangupCause {
  const byName = name === undefined ? undefined : NAME_CAUSE[name.trim().toLowerCase()];
  if (byName) return byName;
  return (status !== undefined && STATUS_CAUSE[status.trim().toLowerCase()]) || 'failed';
}

/** A number without `+` (Plivo's form, `14155550123`) becomes E.164; a SIP address stays as is. */
export function plivoAddress(value: string | undefined): string {
  if (value === undefined) return '';
  const trimmed = value.trim();
  return /^\+?[1-9]\d{6,14}$/.test(trimmed) ? `+${trimmed.replace(/^\+/, '')}` : trimmed;
}

function field(fields: PlivoFields, name: string): string | undefined {
  if (name in fields) return fields[name];
  const lower = name.toLowerCase();
  const key = Object.keys(fields).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : fields[key];
}

function clientStateOf(fields: PlivoFields): string | null {
  const value = field(fields, CLIENT_STATE_FIELD);
  return value !== undefined && CLIENT_STATE.test(value) ? value : null;
}

/**
 * Sorts one Plivo callback into a call fact, an event KNOQRA ignores, or an invalid body:
 * - the answer request (`Event=StartApp`): the call starts
 * - a `<Dial callbackUrl>` request with `DialAction=answer`: the far end answered
 * - a `<Dial callbackUrl>` request with `DialAction=hangup`: the far end hung up
 * - the hangup request (`Event=Hangup`): the call ended
 *
 * A call the browser placed is outbound for KNOQRA even though Plivo calls that leg inbound: it
 * carries the client state, or comes from a `sip:` address.
 */
export function classifyPlivo(fields: PlivoFields): Classified {
  const receivedAt = field(fields, RECEIVED_AT_FIELD);
  const occurredAt = receivedAt === undefined ? Number.NaN : Date.parse(receivedAt);
  if (Number.isNaN(occurredAt)) return { kind: 'invalid' };
  const dialAction = field(fields, 'DialAction');
  const event = field(fields, 'Event');

  let type: ProviderEventType;
  let suffix: string;
  let cause: HangupCause | null = null;
  if (dialAction !== undefined) {
    if (dialAction === 'answer') {
      type = 'call.answered';
      suffix = 'dial:answer';
    } else if (dialAction === 'hangup') {
      type = 'call.completed';
      suffix = 'dial:hangup';
      cause = mapPlivoCause(
        field(fields, 'DialBLegStatus'),
        field(fields, 'DialBLegHangupCauseName'),
      );
    } else {
      return { kind: 'ignored', eventType: `dial.${dialAction}`.slice(0, MAX_EVENT_TYPE) };
    }
  } else if (event === 'StartApp') {
    type = 'call.initiated';
    suffix = 'start';
  } else if (event === 'Hangup') {
    type = 'call.completed';
    suffix = 'hangup';
    cause = mapPlivoCause(field(fields, 'CallStatus'), field(fields, 'HangupCauseName'));
  } else if (event !== undefined && event.length > 0) {
    return { kind: 'ignored', eventType: event.slice(0, MAX_EVENT_TYPE) };
  } else {
    return { kind: 'invalid' };
  }

  const callUuid =
    dialAction !== undefined
      ? (field(fields, 'DialALegUUID') ?? field(fields, 'CallUUID'))
      : field(fields, 'CallUUID');
  if (callUuid === undefined || !UUID.test(callUuid)) return { kind: 'invalid' };

  const clientState = clientStateOf(fields);
  let from: string;
  let to: string;
  let direction: 'inbound' | 'outbound';
  if (dialAction !== undefined) {
    // The dialed leg: a browser endpoint (`sip:`) is a call coming in, a number a call going out.
    from = plivoAddress(field(fields, 'DialBLegFrom'));
    to = plivoAddress(field(fields, 'DialBLegTo'));
    direction = to.startsWith('sip:') ? 'inbound' : 'outbound';
  } else {
    from = plivoAddress(field(fields, 'From'));
    to = plivoAddress(field(fields, 'To'));
    const fromBrowser = clientState !== null || from.startsWith('sip:');
    direction = fromBrowser || field(fields, 'Direction') === 'outbound' ? 'outbound' : 'inbound';
  }
  return {
    kind: 'call',
    fact: {
      externalEventId: `${callUuid}:${suffix}`,
      type,
      callUuid,
      clientState,
      direction,
      from,
      to,
      occurredAt: new Date(occurredAt).toISOString(),
      cause,
    },
  };
}

/**
 * The stored callback as KNOQRA's call event, or null when there is nothing to apply. Like Telnyx,
 * `billableSeconds` is null: the API bills from its own answered and ended times.
 */
export function normalizePlivo(body: unknown): NormalizedCallEvent | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const fields: PlivoFields = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') fields[k] = v;
  const classified = classifyPlivo(fields);
  if (classified.kind !== 'call') return null;
  const { fact } = classified;
  const signal =
    fact.type === 'call.initiated'
      ? ({ type: fact.direction === 'outbound' ? 'dialing' : 'ringing' } as const)
      : fact.type === 'call.answered'
        ? ({ type: 'answered' } as const)
        : ({ type: 'hangup', cause: fact.cause ?? 'failed' } as const);
  if (signal.type !== 'hangup' && (fact.from === '' || fact.to === '')) return null;
  return {
    kind: 'call',
    provider: PLIVO_PROVIDER,
    providerCallId: fact.callUuid,
    clientState: fact.clientState,
    signal,
    direction: fact.direction === 'outbound' ? 'outbound' : 'inbound',
    from: fact.from,
    to: fact.to,
    occurredAt: fact.occurredAt,
    billableSeconds: null,
    voicemail: null,
    orgHint: null,
  };
}

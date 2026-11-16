import type { Call, CallPreflight } from './calls';

export type CallState = Call['state'];
export type CallDirection = Call['direction'];
export type BlockedReason = NonNullable<CallPreflight['decision']>['reason'];

const TERMINAL: ReadonlySet<CallState> = new Set([
  'completed',
  'failed',
  'busy',
  'no_answer',
  'canceled',
]);

/** True until the call reaches a terminal state (mirrors TERMINAL_CALL_STATES in @knoqra/core). */
export function isLiveState(state: CallState): boolean {
  return !TERMINAL.has(state);
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * What the dialer field holds as a number to dial: E.164 (`+` and 7 to 15 digits) or a US number of
 * 10 digits (or 11 starting with 1). Spaces, dots, dashes and brackets are ignored. Null otherwise;
 * the server stays the authority and answers `invalid_phone` for a number it cannot use.
 */
export function dialTarget(text: string): string | null {
  const trimmed = text.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    const e164 = `+${digits}`;
    return E164.test(e164) ? e164 : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export interface CallsSearch {
  contactId?: string;
  to?: string;
}

const CONTACT_ID = /^ct_[0-9a-f]{32}$/;
const NUMBER_INPUT = /^\+?[\d\s().-]{1,24}$/;

/** `/calls` search params: a contact id and a number to prefill. Anything else is dropped. */
export function callsSearch(search: Record<string, unknown>): CallsSearch {
  const result: CallsSearch = {};
  const { contactId, to } = search;
  if (typeof contactId === 'string' && CONTACT_ID.test(contactId)) result.contactId = contactId;
  // The router parses `?to=2025550151` as a number, so take a whole number back as text.
  const toText = typeof to === 'number' && Number.isSafeInteger(to) ? String(to) : to;
  if (typeof toText === 'string' && NUMBER_INPUT.test(toText)) result.to = toText;
  return result;
}

const STATE_LINE: Record<CallState, string> = {
  queued: 'Calling…',
  initiating: 'Calling…',
  ringing: 'Ringing…',
  connected: 'Connected',
  ending: 'Ending…',
  completed: 'Call ended',
  failed: 'Call failed',
  busy: 'Busy',
  no_answer: 'No answer',
  canceled: 'Canceled',
};

/** The live panel's state line. An inbound call that is ringing is ringing for us. */
export function callStateLine(state: CallState, direction: CallDirection): string {
  if (state === 'ringing' && direction === 'inbound') return 'Incoming call…';
  return STATE_LINE[state];
}

/** The StatusDot colour for a state: green when talking, amber on the way, red for a failure. */
export function callStateDot(state: CallState): 'ok' | 'warn' | 'bad' | 'none' {
  if (state === 'connected') return 'ok';
  if (isLiveState(state)) return 'warn';
  return state === 'completed' ? 'none' : 'bad';
}

type Timing = Pick<Call, 'answeredAt' | 'endedAt' | 'billableSeconds'>;

/** Whole seconds talked: billed seconds once known, otherwise from `answeredAt` to the end or now. */
export function elapsedSeconds(call: Timing, now: Date = new Date()): number {
  if (call.billableSeconds !== null && call.endedAt !== null) return call.billableSeconds;
  if (call.answeredAt === null) return 0;
  const end = call.endedAt === null ? now.getTime() : Date.parse(call.endedAt);
  const ms = end - Date.parse(call.answeredAt);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
}

const BLOCKED_COPY: Partial<Record<BlockedReason, string>> = {
  do_not_contact: 'Do not contact. Policy, not a task.',
  revoked: 'Consent was revoked.',
  opted_out: 'They opted out.',
};

/** Why the server blocks this call, in the consent panel's words. */
export function blockedReasonCopy(reason: BlockedReason): string {
  return BLOCKED_COPY[reason] ?? 'Consent does not allow this call.';
}

export interface KeypadKey {
  key: string;
  /** The accessible name: "Digit 1", "Star", "Pound". */
  label: string;
  /** The letters under the digit, as on a phone. */
  letters: string;
}

const LETTERS = ['', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ'];

export const KEYPAD_KEYS: readonly KeypadKey[] = [
  ...LETTERS.map((letters, i) => ({ key: String(i + 1), label: `Digit ${i + 1}`, letters })),
  { key: '*', label: 'Star', letters: '' },
  { key: '0', label: 'Digit 0', letters: '+' },
  { key: '#', label: 'Pound', letters: '' },
];

/** The API's cap on an outcome note (`safeText({ max: 1000 })` in apps/api routes/calls.ts). */
export const NOTE_MAX = 1000;
/** From here on the hint counts down the characters left. */
const NOTE_WARN_AT = 900;

/** The note field's hint: what it is for, then a countdown near the limit. */
export function noteHint(length: number): string {
  if (length < NOTE_WARN_AT) return 'Optional. Saved with the outcome, up to 1,000 characters.';
  const left = Math.max(0, NOTE_MAX - length);
  return left === 1 ? '1 character left' : `${left} characters left`;
}

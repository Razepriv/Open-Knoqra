export const CALL_STATES = [
  'queued',
  'initiating',
  'ringing',
  'connected',
  'ending',
  'completed',
  'failed',
  'busy',
  'no_answer',
  'canceled',
] as const;
export type CallState = (typeof CALL_STATES)[number];

export const TERMINAL_CALL_STATES = [
  'completed',
  'failed',
  'busy',
  'no_answer',
  'canceled',
] as const;

export function isTerminal(state: CallState): boolean {
  return (TERMINAL_CALL_STATES as readonly CallState[]).includes(state);
}

export const HANGUP_CAUSES = [
  'normal',
  'busy',
  'no_answer',
  'rejected',
  'canceled',
  'failed',
] as const;
export type HangupCause = (typeof HANGUP_CAUSES)[number];

export type CallSignal =
  | { type: 'dialing' }
  | { type: 'ringing' }
  | { type: 'answered' }
  | { type: 'hangup_requested' }
  | { type: 'hangup'; cause: HangupCause }
  | { type: 'cancel' };

const TERMINAL_RANK = 5;

const RANK: Record<CallState, number> = {
  queued: 0,
  initiating: 1,
  ringing: 2,
  connected: 3,
  ending: 4,
  completed: TERMINAL_RANK,
  failed: TERMINAL_RANK,
  busy: TERMINAL_RANK,
  no_answer: TERMINAL_RANK,
  canceled: TERMINAL_RANK,
};

const PRE_CONNECT_HANGUP: Record<HangupCause, CallState> = {
  busy: 'busy',
  no_answer: 'no_answer',
  rejected: 'busy',
  canceled: 'canceled',
  normal: 'canceled',
  failed: 'failed',
};

function hangupTarget(state: CallState, cause: HangupCause): CallState {
  if (state === 'connected' || state === 'ending') {
    return cause === 'failed' ? 'failed' : 'completed';
  }
  return PRE_CONNECT_HANGUP[cause];
}

/** The state a signal asks for, or null when it does not apply to `state`. */
function signalTarget(state: CallState, signal: CallSignal): CallState | null {
  switch (signal.type) {
    case 'dialing':
      return 'initiating';
    case 'ringing':
      return 'ringing';
    case 'answered':
      return 'connected';
    case 'hangup_requested':
      return 'ending';
    case 'hangup':
      return hangupTarget(state, signal.cause);
    case 'cancel':
      return state === 'queued' || state === 'initiating' || state === 'ringing'
        ? 'canceled'
        : null;
  }
}

/**
 * Pure, monotonic transition: a signal never moves a call backwards, terminal
 * states absorb everything, and duplicates are no-ops.
 */
export function applyCallSignal(
  state: CallState,
  signal: CallSignal,
): { next: CallState; changed: boolean } {
  const target = signalTarget(state, signal);
  if (target === null || RANK[target] <= RANK[state]) {
    return { next: state, changed: false };
  }
  return { next: target, changed: true };
}

export const CALL_OUTCOMES = [
  'connected',
  'rescheduled',
  'follow_up',
  'voicemail',
  'no_answer',
  'wrong_number',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: 'Connected',
  rescheduled: 'Rescheduled',
  follow_up: 'Follow-up',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  wrong_number: 'Wrong number',
};

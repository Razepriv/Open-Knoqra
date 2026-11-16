import { describe, expect, it } from 'vitest';
import {
  applyCallSignal,
  CALL_OUTCOMES,
  CALL_STATES,
  type CallSignal,
  type CallState,
  HANGUP_CAUSES,
  isTerminal,
  OUTCOME_LABELS,
  TERMINAL_CALL_STATES,
} from './call-state';

type Label =
  | 'dialing'
  | 'ringing'
  | 'answered'
  | 'hangup_requested'
  | 'hangup:normal'
  | 'hangup:busy'
  | 'hangup:no_answer'
  | 'hangup:rejected'
  | 'hangup:canceled'
  | 'hangup:failed'
  | 'cancel';

const signals: Record<Label, CallSignal> = {
  dialing: { type: 'dialing' },
  ringing: { type: 'ringing' },
  answered: { type: 'answered' },
  hangup_requested: { type: 'hangup_requested' },
  'hangup:normal': { type: 'hangup', cause: 'normal' },
  'hangup:busy': { type: 'hangup', cause: 'busy' },
  'hangup:no_answer': { type: 'hangup', cause: 'no_answer' },
  'hangup:rejected': { type: 'hangup', cause: 'rejected' },
  'hangup:canceled': { type: 'hangup', cause: 'canceled' },
  'hangup:failed': { type: 'hangup', cause: 'failed' },
  cancel: { type: 'cancel' },
};
const labels = Object.keys(signals) as Label[];

// Expected next state per (state, signal); `null` means "no change".
const beforeConnect: Record<Label, CallState | null> = {
  dialing: 'initiating',
  ringing: 'ringing',
  answered: 'connected',
  hangup_requested: 'ending',
  'hangup:normal': 'canceled',
  'hangup:busy': 'busy',
  'hangup:no_answer': 'no_answer',
  'hangup:rejected': 'busy',
  'hangup:canceled': 'canceled',
  'hangup:failed': 'failed',
  cancel: 'canceled',
};
const afterConnect: Record<Label, CallState | null> = {
  dialing: null,
  ringing: null,
  answered: null,
  hangup_requested: 'ending',
  'hangup:normal': 'completed',
  'hangup:busy': 'completed',
  'hangup:no_answer': 'completed',
  'hangup:rejected': 'completed',
  'hangup:canceled': 'completed',
  'hangup:failed': 'failed',
  cancel: null,
};
const absorbing = Object.fromEntries(labels.map((l) => [l, null])) as Record<Label, null>;
const expected: Record<CallState, Record<Label, CallState | null>> = {
  queued: beforeConnect,
  initiating: { ...beforeConnect, dialing: null },
  ringing: { ...beforeConnect, dialing: null, ringing: null },
  connected: afterConnect,
  ending: { ...afterConnect, hangup_requested: null },
  completed: absorbing,
  failed: absorbing,
  busy: absorbing,
  no_answer: absorbing,
  canceled: absorbing,
};

const pairs: [CallState, Label, CallState | null][] = [];
for (const state of CALL_STATES) {
  for (const label of labels) {
    pairs.push([state, label, expected[state][label]]);
  }
}

describe('call states', () => {
  it('lists states and terminals', () => {
    expect(CALL_STATES).toEqual([
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
    ]);
    expect(TERMINAL_CALL_STATES).toEqual(['completed', 'failed', 'busy', 'no_answer', 'canceled']);
    for (const s of CALL_STATES) {
      expect(isTerminal(s)).toBe((TERMINAL_CALL_STATES as readonly string[]).includes(s));
    }
    expect(HANGUP_CAUSES).toEqual([
      'normal',
      'busy',
      'no_answer',
      'rejected',
      'canceled',
      'failed',
    ]);
  });

  it('has a label for every outcome', () => {
    expect(CALL_OUTCOMES).toEqual([
      'connected',
      'rescheduled',
      'follow_up',
      'voicemail',
      'no_answer',
      'wrong_number',
    ]);
    expect(OUTCOME_LABELS).toEqual({
      connected: 'Connected',
      rescheduled: 'Rescheduled',
      follow_up: 'Follow-up',
      voicemail: 'Voicemail',
      no_answer: 'No answer',
      wrong_number: 'Wrong number',
    });
  });
});

describe('applyCallSignal', () => {
  it('covers every state and signal pair', () => {
    expect(pairs).toHaveLength(CALL_STATES.length * labels.length);
  });

  it.each(pairs)('%s + %s -> %s', (state, label, next) => {
    const result = applyCallSignal(state, signals[label]);
    expect(result).toEqual(
      next === null ? { next: state, changed: false } : { next, changed: true },
    );
  });

  it('accepts a frozen signal', () => {
    const signal: CallSignal = Object.freeze({ type: 'hangup', cause: 'normal' });
    expect(applyCallSignal('connected', signal).next).toBe('completed');
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANK: Record<CallState, number> = {
  queued: 0,
  initiating: 1,
  ringing: 2,
  connected: 3,
  ending: 4,
  completed: 5,
  failed: 5,
  busy: 5,
  no_answer: 5,
  canceled: 5,
};

describe('applyCallSignal properties', () => {
  it('converges and never moves backwards under reordered and duplicated delivery', () => {
    const rand = mulberry32(0xc0ffee);
    const base: CallSignal[] = [
      signals.dialing,
      signals.ringing,
      signals.answered,
      signals['hangup:normal'],
    ];
    for (let run = 0; run < 500; run++) {
      const seq = [...base];
      for (let i = seq.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [seq[i], seq[j]] = [seq[j] as CallSignal, seq[i] as CallSignal];
      }
      const delivered: CallSignal[] = [];
      for (const s of seq) {
        const copies = 1 + Math.floor(rand() * 3);
        for (let c = 0; c < copies; c++) delivered.push(s);
      }
      let state: CallState = 'queued';
      for (const s of delivered) {
        const { next } = applyCallSignal(state, s);
        expect(RANK[next]).toBeGreaterThanOrEqual(RANK[state]);
        state = next;
      }
      const answeredAt = delivered.findIndex((s) => s.type === 'answered');
      const hangupAt = delivered.findIndex((s) => s.type === 'hangup');
      expect(state).toBe(answeredAt < hangupAt ? 'completed' : 'canceled');
    }
  });
});

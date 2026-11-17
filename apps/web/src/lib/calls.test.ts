import { describe, expect, it } from 'vitest';
import {
  type Call,
  callErrorCopy,
  callStateRank,
  canLogOutcome,
  cutOffEndedCopy,
  cutOffWarningCopy,
  formatDuration,
  recentStateCopy,
  secondsUntilCutOff,
  spendNoteCopy,
  unreadCount,
} from './calls';

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [61, '1:01'],
    [605, '10:05'],
    [3_600, '60:00'],
    [-3, '0:00'],
    [12.9, '0:12'],
  ])('formats %d seconds as %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe('callStateRank', () => {
  it.each([
    ['queued', 0],
    ['initiating', 1],
    ['ringing', 2],
    ['connected', 3],
    ['ending', 4],
    ['completed', 5],
    ['failed', 5],
    ['busy', 5],
    ['no_answer', 5],
    ['canceled', 5],
  ] as const)('ranks %s as %d', (state, rank) => {
    expect(callStateRank(state)).toBe(rank);
  });

  it('ranks an unknown state below every known one', () => {
    expect(callStateRank('mystery')).toBe(-1);
  });
});

describe('callErrorCopy', () => {
  const CODES = [
    'mic_denied',
    'mic_unavailable',
    'connect_failed',
    'dial_failed',
    'hangup_failed',
    'voice_not_configured',
    'call_blocked',
    'needs_review',
    'call_in_progress',
    'spend_blocked',
    'invalid_state',
    'outcome_exists',
    'invalid_phone',
    'not_found',
    'validation_error',
    'unauthenticated',
    'no_active_org',
    'forbidden',
    'internal_error',
    'rate_limited',
  ];

  it.each(CODES)('has copy for %s that is plain prose', (code) => {
    const text = callErrorCopy(code);
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/_/);
  });

  it('says a failed hangup did not end the call', () => {
    expect(callErrorCopy('hangup_failed')).toBe(
      'The call could not be ended. Press Hang up to try again.',
    );
  });

  it('asks the caller to wait when dialing is rate limited', () => {
    expect(callErrorCopy('rate_limited')).toBe(
      'Too many call attempts. Wait a minute and try again.',
    );
  });

  it('falls back for an unknown or missing code', () => {
    expect(callErrorCopy('totally_new')).toBe(callErrorCopy(undefined));
    expect(callErrorCopy(undefined)).toMatch(/try again/i);
  });

  it('tells the spend reasons apart', () => {
    expect(callErrorCopy('spend_blocked', 'insufficient_funds')).toMatch(/credit/i);
    expect(callErrorCopy('spend_blocked', 'stop_cap')).toMatch(/cap/i);
    expect(callErrorCopy('spend_blocked', 'insufficient_funds')).not.toBe(
      callErrorCopy('spend_blocked', 'stop_cap'),
    );
  });

  it('tells the blocked reasons apart', () => {
    const reasons = ['do_not_contact', 'revoked', 'opted_out'].map((r) =>
      callErrorCopy('call_blocked', r),
    );
    expect(new Set(reasons).size).toBe(3);
  });
});

describe('recentStateCopy', () => {
  const call = (over: Partial<Call>): Call => ({
    id: 'cl_a',
    userId: 'u_a',
    direction: 'outbound',
    state: 'completed',
    contact: null,
    fromE164: '+12025550100',
    toE164: '+12025550123',
    createdAt: '2026-11-12T10:00:00.000Z',
    answeredAt: '2026-11-12T10:00:05.000Z',
    endedAt: '2026-11-12T10:02:19.000Z',
    billableSeconds: 134,
    costMicros: 30_000,
    hangupCause: 'normal_clearing',
    outcome: null,
    outcomeNote: null,
    reviewConfirmed: false,
    paidUntil: null,
    cutOff: null,
    ...over,
  });

  it.each([
    [{}, 'Completed · 2:14'],
    [{ direction: 'inbound' as const }, 'Completed · 2:14'],
    [{ direction: 'inbound' as const, state: 'no_answer' as const, answeredAt: null }, 'Missed'],
    [{ direction: 'inbound' as const, state: 'completed' as const, answeredAt: null }, 'Missed'],
    [{ state: 'busy' as const }, 'Busy'],
    [{ state: 'no_answer' as const }, 'No answer'],
    [{ state: 'canceled' as const }, 'Canceled'],
    [{ state: 'failed' as const }, 'Failed'],
    [{ state: 'ringing' as const }, 'Ringing'],
    [{ state: 'connected' as const }, 'Connected'],
  ])('%j reads %s', (over, text) => {
    expect(recentStateCopy(call(over))).toBe(text);
  });

  it('offers Log outcome on an ended call without one, but never on a canceled call', () => {
    expect(canLogOutcome(call({}), 'u_a')).toBe(true);
    expect(canLogOutcome(call({ state: 'busy' }), 'u_a')).toBe(true);
    expect(canLogOutcome(call({ outcome: 'connected' }), 'u_a')).toBe(false);
    expect(canLogOutcome(call({ state: 'connected' }), 'u_a')).toBe(false);
    expect(canLogOutcome(call({ state: 'canceled' }), 'u_a')).toBe(false);
  });

  it("never offers Log outcome on another member's call, or before we know who is signed in", () => {
    expect(canLogOutcome(call({ userId: 'u_other' }), 'u_a')).toBe(false);
    expect(canLogOutcome(call({}), undefined)).toBe(false);
  });
});

describe('unreadCount', () => {
  it('counts voicemails nobody has listened to', () => {
    expect(unreadCount(undefined)).toBe(0);
    expect(
      unreadCount([
        { listenedAt: null },
        { listenedAt: '2026-11-12T10:00:00.000Z' },
        { listenedAt: null },
      ]),
    ).toBe(2);
  });
});

describe('provider balance spend copy', () => {
  it('explains a low or exhausted Telnyx balance when a call is blocked', () => {
    expect(callErrorCopy('spend_blocked', 'provider_low')).toBe(
      'Your phone provider balance is low. Top it up with your provider to keep calling.',
    );
    expect(callErrorCopy('spend_blocked', 'provider_exhausted')).toBe(
      'Your phone provider balance is too low to place a call. Top it up with your provider.',
    );
  });
});

describe('spendNoteCopy', () => {
  it('says nothing when spend is fine', () => {
    expect(spendNoteCopy('ok', 'ok')).toBeNull();
  });

  it('keeps the wallet copy for the wallet reasons', () => {
    expect(spendNoteCopy('warn', 'warn_cap')).toBe("You're near this month's spend cap");
    expect(spendNoteCopy('stop', 'insufficient_funds')).toBe('Balance too low to hold a call.');
    expect(spendNoteCopy('stop', 'stop_cap')).toBe(
      'Spend cap reached. Raise it in the wallet to call.',
    );
  });

  it('shows the Telnyx copy, not the cap copy, for the provider reasons', () => {
    expect(spendNoteCopy('warn', 'provider_low')).toBe(
      'Your phone provider balance is low. Top it up with your provider to keep calling.',
    );
    expect(spendNoteCopy('stop', 'provider_exhausted')).toBe(
      'Your phone provider balance is too low to place a call. Top it up with your provider.',
    );
  });
});

describe('cut-off copy', () => {
  const live = {
    state: 'connected' as const,
    hangupCause: null,
    cutOff: { reason: 'insufficient_funds' as const, at: '2026-11-17T10:09:50.000Z' },
  };

  it('counts down to the cut-off of a live call, never below zero', () => {
    expect(secondsUntilCutOff(live, new Date('2026-11-17T10:09:00.000Z'))).toBe(50);
    expect(secondsUntilCutOff(live, new Date('2026-11-17T10:09:49.400Z'))).toBe(1);
    expect(secondsUntilCutOff(live, new Date('2026-11-17T10:10:30.000Z'))).toBe(0);
    expect(secondsUntilCutOff({ ...live, cutOff: null }, new Date())).toBeNull();
    expect(secondsUntilCutOff({ ...live, state: 'completed' }, new Date())).toBeNull();
  });

  it('says why an ended call was cut, and nothing for other calls', () => {
    expect(cutOffEndedCopy({ ...live, state: 'completed', hangupCause: 'cut_off' })).toBe(
      'Call ended: out of credit',
    );
    expect(
      cutOffEndedCopy({
        state: 'completed',
        hangupCause: 'cut_off',
        cutOff: { reason: 'stop_cap', at: live.cutOff.at },
      }),
    ).toBe('Call ended: monthly spend cap reached');
    expect(cutOffEndedCopy({ ...live, state: 'completed', hangupCause: 'normal' })).toBeNull();
    expect(cutOffEndedCopy(live)).toBeNull();
  });

  it('has a warning for every reason, with no numbers in it', () => {
    for (const reason of ['insufficient_funds', 'stop_cap', 'paid_time_over'] as const) {
      expect(cutOffWarningCopy(reason)).toMatch(/end soon/);
      expect(cutOffWarningCopy(reason)).not.toMatch(/\d/);
    }
  });
});

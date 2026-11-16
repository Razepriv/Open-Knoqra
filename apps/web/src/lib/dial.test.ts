import { describe, expect, it } from 'vitest';
import {
  blockedReasonCopy,
  callStateLine,
  callsSearch,
  dialTarget,
  elapsedSeconds,
  isLiveState,
  KEYPAD_KEYS,
  NOTE_MAX,
  noteHint,
} from './dial';

describe('dialTarget', () => {
  it('accepts E.164 and US 10-digit numbers, with spaces and punctuation', () => {
    expect(dialTarget('+12025550151')).toBe('+12025550151');
    expect(dialTarget('+1 202 555 0151')).toBe('+12025550151');
    expect(dialTarget('2025550151')).toBe('+12025550151');
    expect(dialTarget('(202) 555-0151')).toBe('+12025550151');
    expect(dialTarget('1 202 555 0151')).toBe('+12025550151');
    expect(dialTarget('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('rejects what is not a whole number yet', () => {
    expect(dialTarget('')).toBeNull();
    expect(dialTarget('202555')).toBeNull();
    expect(dialTarget('Ines')).toBeNull();
    expect(dialTarget('+1')).toBeNull();
    expect(dialTarget('12345678901234567')).toBeNull();
    expect(dialTarget('+0123456789')).toBeNull();
  });
});

describe('callsSearch', () => {
  it('keeps a valid contact id and number', () => {
    const contactId = `ct_${'a'.repeat(32)}`;
    expect(callsSearch({ contactId, to: '+12025550151' })).toEqual({
      contactId,
      to: '+12025550151',
    });
  });

  it('drops unknown keys and invalid values', () => {
    expect(callsSearch({ contactId: 'nope', to: 'drop table', other: 1 })).toEqual({});
    expect(callsSearch({ contactId: 7, to: ['+12025550151'] })).toEqual({});
    expect(callsSearch({ to: '1'.repeat(40) })).toEqual({});
  });

  it('takes a number that the router parsed as a number', () => {
    expect(callsSearch({ to: 2025550151 })).toEqual({ to: '2025550151' });
  });
});

describe('callStateLine', () => {
  it('words every state', () => {
    expect(callStateLine('queued', 'outbound')).toBe('Calling…');
    expect(callStateLine('initiating', 'outbound')).toBe('Calling…');
    expect(callStateLine('ringing', 'outbound')).toBe('Ringing…');
    expect(callStateLine('ringing', 'inbound')).toBe('Incoming call…');
    expect(callStateLine('connected', 'outbound')).toBe('Connected');
    expect(callStateLine('ending', 'outbound')).toBe('Ending…');
    expect(callStateLine('completed', 'outbound')).toBe('Call ended');
    expect(callStateLine('busy', 'outbound')).toBe('Busy');
    expect(callStateLine('no_answer', 'outbound')).toBe('No answer');
    expect(callStateLine('failed', 'outbound')).toBe('Call failed');
    expect(callStateLine('canceled', 'outbound')).toBe('Canceled');
  });
});

describe('isLiveState', () => {
  it('is true until the call reaches a terminal state', () => {
    expect(isLiveState('ringing')).toBe(true);
    expect(isLiveState('ending')).toBe(true);
    expect(isLiveState('completed')).toBe(false);
    expect(isLiveState('canceled')).toBe(false);
  });
});

describe('elapsedSeconds', () => {
  const answeredAt = '2026-11-12T10:00:00.000Z';
  it('counts from answeredAt while connected', () => {
    const call = { answeredAt, endedAt: null, billableSeconds: null };
    expect(elapsedSeconds(call, new Date('2026-11-12T10:01:05.900Z'))).toBe(65);
  });
  it('is zero before the call is answered, and never negative', () => {
    expect(elapsedSeconds({ answeredAt: null, endedAt: null, billableSeconds: null })).toBe(0);
    expect(
      elapsedSeconds(
        { answeredAt, endedAt: null, billableSeconds: null },
        new Date('2026-11-12T09:59:00.000Z'),
      ),
    ).toBe(0);
  });
  it('prefers billed seconds, then the end time, once the call is over', () => {
    expect(
      elapsedSeconds({ answeredAt, endedAt: '2026-11-12T10:00:09.000Z', billableSeconds: 12 }),
    ).toBe(12);
    expect(
      elapsedSeconds({ answeredAt, endedAt: '2026-11-12T10:00:09.000Z', billableSeconds: null }),
    ).toBe(9);
  });
});

describe('blockedReasonCopy', () => {
  it('uses the consent copy for each reason', () => {
    expect(blockedReasonCopy('do_not_contact')).toBe('Do not contact. Policy, not a task.');
    expect(blockedReasonCopy('revoked')).toBe('Consent was revoked.');
    expect(blockedReasonCopy('opted_out')).toBe('They opted out.');
    expect(blockedReasonCopy('consent_required')).toBe('Consent does not allow this call.');
  });
});

describe('KEYPAD_KEYS', () => {
  it('has twelve keys with spoken labels', () => {
    expect(KEYPAD_KEYS.map((k) => k.key).join('')).toBe('123456789*0#');
    expect(KEYPAD_KEYS[0]?.label).toBe('Digit 1');
    expect(KEYPAD_KEYS[9]?.label).toBe('Star');
    expect(KEYPAD_KEYS[11]?.label).toBe('Pound');
    expect(KEYPAD_KEYS[1]?.letters).toBe('ABC');
  });
});

describe('noteHint', () => {
  it('matches the API cap of 1000 characters', () => {
    expect(NOTE_MAX).toBe(1000);
  });
  it('explains the field until the note nears the cap, then counts down', () => {
    expect(noteHint(0)).toBe('Optional. Saved with the outcome, up to 1,000 characters.');
    expect(noteHint(899)).toBe('Optional. Saved with the outcome, up to 1,000 characters.');
    expect(noteHint(900)).toBe('100 characters left');
    expect(noteHint(999)).toBe('1 character left');
    expect(noteHint(1000)).toBe('0 characters left');
    expect(noteHint(1200)).toBe('0 characters left');
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import { citationHref, ottoErrorMessage, ottoEyebrow, ottoMood } from './otto';

const CONTACT = 'ct_0123456789abcdef0123456789abcdef';
const OTHER = 'ct_fedcba9876543210fedcba9876543210';

describe('citationHref', () => {
  it('links a contact citation to that contact', () => {
    expect(citationHref({ kind: 'contact', ref: OTHER }, CONTACT)).toBe(`/contacts/${OTHER}`);
    expect(citationHref({ kind: 'contact', ref: OTHER }, null)).toBe(`/contacts/${OTHER}`);
  });

  it("links a timeline citation to the draft's contact, or nowhere without one", () => {
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, CONTACT)).toBe(`/contacts/${CONTACT}`);
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, null)).toBeNull();
    expect(citationHref({ kind: 'timeline', ref: 'te_1' })).toBeNull();
  });

  it("links a task citation to the draft's contact, else to the task list", () => {
    expect(citationHref({ kind: 'task', ref: 'tk_1' }, CONTACT)).toBe(`/contacts/${CONTACT}`);
    expect(citationHref({ kind: 'task', ref: 'tk_1' }, null)).toBe('/tasks');
  });

  it('does not link a notification citation', () => {
    expect(citationHref({ kind: 'notification', ref: 'nt_1' }, CONTACT)).toBeNull();
    expect(citationHref({ kind: 'notification', ref: 'nt_1' }, null)).toBeNull();
  });

  it('never builds a link from a ref that is not a contact id', () => {
    expect(citationHref({ kind: 'contact', ref: '../settings' }, null)).toBeNull();
    expect(citationHref({ kind: 'timeline', ref: 'te_1' }, '//evil.example.test')).toBeNull();
  });
});

describe('ottoEyebrow', () => {
  it('labels each kind of output', () => {
    expect(ottoEyebrow({ kind: 'draft', channel: 'sms' })).toBe('DRAFT · SMS · NOT SENT');
    expect(ottoEyebrow({ kind: 'draft', channel: 'whatsapp' })).toBe('DRAFT · WHATSAPP · NOT SENT');
    expect(ottoEyebrow({ kind: 'draft', channel: null })).toBe('DRAFT · NOT SENT');
    expect(ottoEyebrow({ kind: 'brief', channel: null })).toBe('BRIEF');
    expect(ottoEyebrow({ kind: 'digest', channel: null })).toBe('WHAT YOU MISSED');
  });
});

describe('ottoErrorMessage', () => {
  it('names the daily limit and an outage plainly', () => {
    expect(ottoErrorMessage(new ApiError(429, 'x', 'quota_exceeded'))).toBe(
      "Otto has reached today's limit.",
    );
    expect(ottoErrorMessage(new ApiError(503, 'x', 'ai_unavailable'))).toBe(
      'Otto is unavailable right now. Try again in a minute.',
    );
  });

  it('explains a contact Otto cannot use and a lost connection', () => {
    expect(ottoErrorMessage(new ApiError(404, 'x', 'not_found'))).toBe(
      'We could not find that contact.',
    );
    expect(ottoErrorMessage(new ApiError(422, 'x', 'contact_archived'))).toBe(
      'Otto can only work with active contacts.',
    );
    expect(ottoErrorMessage(new NetworkError())).toBe(
      'We could not reach KNOQRA. Check your connection and try again.',
    );
  });

  it('never shows server text for anything else', () => {
    expect(ottoErrorMessage(new ApiError(500, 'stack trace here'))).toBe(
      'Otto could not answer. Try again.',
    );
    expect(ottoErrorMessage(new Error('boom'))).toBe('Otto could not answer. Try again.');
  });
});

describe('ottoMood', () => {
  it('thinks while pending, is happy with a result and idle otherwise', () => {
    expect(ottoMood({ pending: true, hasResult: true })).toBe('thinking');
    expect(ottoMood({ pending: false, hasResult: true })).toBe('happy');
    expect(ottoMood({ pending: false, hasResult: false })).toBe('idle');
  });
});

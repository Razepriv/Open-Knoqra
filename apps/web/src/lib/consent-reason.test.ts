import { describe, expect, it } from 'vitest';
import { liftReasonError, liftsDoNotContact, reasonCount } from './consent-reason';

describe('liftsDoNotContact', () => {
  it('is true only for a grant over do not contact', () => {
    expect(liftsDoNotContact('do_not_contact', 'granted')).toBe(true);
    expect(liftsDoNotContact('do_not_contact', 'revoked')).toBe(false);
    expect(liftsDoNotContact('do_not_contact', 'opted_out')).toBe(false);
    expect(liftsDoNotContact('do_not_contact', 'do_not_contact')).toBe(false);
    expect(liftsDoNotContact('opted_out', 'granted')).toBe(false);
    expect(liftsDoNotContact('unknown', 'granted')).toBe(false);
    expect(liftsDoNotContact(undefined, 'granted')).toBe(false);
  });
});

describe('liftReasonError', () => {
  it('asks for a reason when there is none', () => {
    expect(liftReasonError('')).toBe('Add how they gave consent again.');
    expect(liftReasonError('   \n ')).toBe('Add how they gave consent again.');
  });

  it('needs 5 to 500 characters after trimming, like the API', () => {
    expect(liftReasonError('  abcd  ')).toBe('Use at least 5 characters.');
    expect(liftReasonError('abcde')).toBeNull();
    expect(liftReasonError('x'.repeat(500))).toBeNull();
    expect(liftReasonError('x'.repeat(501))).toBe('Use 500 characters or fewer.');
  });
});

describe('reasonCount', () => {
  it('counts trimmed characters against the limit', () => {
    expect(reasonCount('')).toBe('0 / 500');
    expect(reasonCount('  Called back  ')).toBe('11 / 500');
  });
});

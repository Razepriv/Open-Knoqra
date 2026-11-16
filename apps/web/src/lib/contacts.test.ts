import { gradients } from '@knoqra/tokens';
import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './api';
import {
  contactErrorMessage,
  formatPhone,
  gradientFor,
  localTimeIn,
  parseTags,
  resultAnnouncement,
  validateContactFields,
} from './contacts';

describe('gradientFor', () => {
  it('returns the same gradient for the same id, every time', () => {
    const id = 'ct_0123456789abcdef0123456789abcdef';
    expect(gradientFor(id)).toBe(gradientFor(id));
  });

  it('always picks a known avatar gradient', () => {
    for (const id of ['ct_a', 'ct_b', 'ct_ffffffffffffffffffffffffffffffff', '', 'ct_é']) {
      expect(Object.keys(gradients)).toContain(gradientFor(id));
    }
  });

  it('spreads different ids across several gradients', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) seen.add(gradientFor(`ct_${i.toString(16).padStart(32, '0')}`));
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('never picks the highlight gradient reserved for emphasis', () => {
    for (let i = 0; i < 200; i += 1) expect(gradientFor(`ct_${i}`)).not.toBe('hl');
  });
});

describe('contactErrorMessage', () => {
  it('explains an invalid phone number on the phone field', () => {
    expect(contactErrorMessage(new ApiError(400, 'Invalid phone.', 'invalid_phone'))).toEqual({
      field: 'phone',
      message: 'Enter a full number with country code, like +1 202 555 0123.',
    });
  });

  it('explains a duplicate number on the phone field', () => {
    expect(contactErrorMessage(new ApiError(409, 'Exists.', 'duplicate_contact'))).toEqual({
      field: 'phone',
      message: 'A contact with this number already exists.',
    });
  });

  it('keeps the server wording when the holder is archived', () => {
    const archived = 'This number belongs to an archived contact. Restore it instead.';
    expect(contactErrorMessage(new ApiError(409, archived, 'duplicate_contact'))).toEqual({
      field: 'phone',
      message: archived,
    });
  });

  it('reports other validation problems on the form', () => {
    expect(contactErrorMessage(new ApiError(400, 'Bad.', 'validation_error'))).toEqual({
      field: 'form',
      message: 'Some details are not valid. Check them and try again.',
    });
  });

  it('says so when the server cannot be reached', () => {
    expect(contactErrorMessage(new NetworkError()).message).toBe(
      'We could not reach KNOQRA. Check your connection and try again.',
    );
  });

  it('falls back to a calm generic message', () => {
    expect(contactErrorMessage(new ApiError(500, 'boom', 'internal_error'))).toEqual({
      field: 'form',
      message: 'We could not save this contact. Try again in a moment.',
    });
    expect(contactErrorMessage('weird').field).toBe('form');
  });
});

describe('parseTags', () => {
  it('splits on commas, trims and drops blanks and repeats', () => {
    expect(parseTags(' VIP, , lead ,vip,Lead ')).toEqual(['VIP', 'lead']);
  });

  it('returns nothing for an empty box', () => {
    expect(parseTags('   ')).toEqual([]);
  });
});

describe('formatPhone', () => {
  it('groups North American numbers', () => {
    expect(formatPhone('+12025550123')).toBe('+1 202 555 0123');
  });

  it('leaves other numbers as stored', () => {
    expect(formatPhone('+442071838750')).toBe('+442071838750');
  });
});

describe('localTimeIn', () => {
  it('formats a moment in the contact zone', () => {
    const at = new Date('2026-11-12T15:41:00Z');
    expect(localTimeIn('America/Chicago', at, 'en-US')).toMatch(/9:41\s?AM/);
    expect(localTimeIn('America/Chicago', at, 'de-DE')).toBe('9:41');
  });

  it('returns null for a missing or unknown zone', () => {
    expect(localTimeIn(null)).toBeNull();
    expect(localTimeIn('Not/AZone')).toBeNull();
  });
});

describe('validateContactFields', () => {
  it('asks for a name and a phone number', () => {
    expect(validateContactFields({ displayName: ' ', phone: '', email: '' })).toEqual({
      displayName: 'Enter a name.',
      phone: 'Enter a phone number.',
    });
  });

  it('checks the email only when one is given', () => {
    expect(validateContactFields({ displayName: 'A', phone: '1', email: 'nope' })).toEqual({
      email: 'Enter an email address like name@company.com.',
    });
    expect(validateContactFields({ displayName: 'A', phone: '1', email: '' })).toEqual({});
    expect(validateContactFields({ displayName: 'A', phone: '1', email: 'a@b.co' })).toEqual({});
  });
});

describe('resultAnnouncement', () => {
  it('says nothing while loading or after an error', () => {
    expect(resultAnnouncement({ settled: false, count: 0, more: false, searching: false })).toBe(
      '',
    );
  });

  it('counts the results', () => {
    expect(resultAnnouncement({ settled: true, count: 1, more: false, searching: true })).toBe(
      '1 contact',
    );
    expect(resultAnnouncement({ settled: true, count: 12, more: false, searching: false })).toBe(
      '12 contacts',
    );
    expect(resultAnnouncement({ settled: true, count: 50, more: true, searching: false })).toBe(
      '50+ contacts',
    );
  });

  it('says when a search finds nothing', () => {
    expect(resultAnnouncement({ settled: true, count: 0, more: false, searching: true })).toBe(
      'No contacts match your search.',
    );
    expect(resultAnnouncement({ settled: true, count: 0, more: false, searching: false })).toBe(
      'No contacts yet.',
    );
  });
});

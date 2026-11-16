import { describe, expect, it } from 'vitest';
import {
  copy,
  displayNameError,
  looksLikeEmail,
  MAX_NAME_LENGTH,
  resetErrorMessage,
  securityErrorMessage,
  signInErrorMessage,
  signUpErrorField,
  signUpErrorMessage,
  twoFactorErrorMessage,
  validateNewPassword,
} from './auth-errors';

describe('auth error copy', () => {
  it('maps sign-up errors to plain language', () => {
    expect(signUpErrorMessage({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', status: 422 })).toBe(
      'That email is already registered.',
    );
    expect(signUpErrorMessage({ code: 'USER_ALREADY_EXISTS' })).toBe(copy.emailTaken);
    expect(signUpErrorMessage({ code: 'PASSWORD_TOO_SHORT' })).toBe('Use at least 12 characters.');
    expect(signUpErrorMessage({ code: 'INVALID_EMAIL' })).toBe(copy.emailInvalid);
    expect(signUpErrorMessage({ status: 500 })).toBe(copy.signUpFailed);
  });

  it('puts a name the server refused on the name field', () => {
    const refused = {
      status: 400,
      message: 'Name must be 1 to 120 characters without control characters',
    };
    expect(signUpErrorMessage(refused)).toBe(copy.nameRejected);
    expect(signUpErrorField(copy.nameRejected)).toBe('name');
    // A 400 about something else, or a name in a non-400 message, stays a form-level error.
    expect(signUpErrorMessage({ status: 400, message: 'Invalid request body' })).toBe(
      copy.signUpFailed,
    );
    expect(signUpErrorMessage({ status: 500, message: 'Name lookup failed' })).toBe(
      copy.signUpFailed,
    );
    expect(signUpErrorField(copy.signUpFailed)).toBeNull();
    expect(signUpErrorField(copy.emailTaken)).toBeNull();
    expect(signUpErrorField(copy.passwordTooShort)).toBe('password');
    expect(signUpErrorField(copy.passwordTooLong)).toBe('password');
  });

  it('checks a display name with the server rule: 1 to 120 characters, no control characters', () => {
    expect(MAX_NAME_LENGTH).toBe(120);
    expect(displayNameError('Ana Silva')).toBeUndefined();
    expect(displayNameError('a'.repeat(120))).toBeUndefined();
    expect(displayNameError(`  ${'a'.repeat(120)}  `)).toBeUndefined(); // trimmed first
    expect(displayNameError('')).toBe(copy.nameRequired);
    expect(displayNameError(' \t ')).toBe(copy.nameRequired);
    expect(displayNameError('a'.repeat(121))).toBe(copy.nameTooLong);
    // UTF-16 length, as the server counts: 60 emoji are 120 units, 61 are 122.
    expect(displayNameError('\u{1F600}'.repeat(60))).toBeUndefined();
    expect(displayNameError('\u{1F600}'.repeat(61))).toBe(copy.nameTooLong);
    expect(displayNameError('Ana\u0000Silva')).toBe(copy.nameInvalidCharacters);
    expect(displayNameError('Ana\u001BSilva')).toBe(copy.nameInvalidCharacters);
    // Tab, line feed and carriage return are allowed inside the name, as on the server.
    expect(displayNameError('Ana\tSilva')).toBeUndefined();
    expect(displayNameError('Ana\nSilva')).toBeUndefined();
    expect(displayNameError('Ana\rSilva')).toBeUndefined();
  });

  it('flags every C0 control character the server refuses, and only those', () => {
    for (let code = 0; code < 0x20; code += 1) {
      const allowed = code === 0x09 || code === 0x0a || code === 0x0d;
      expect(displayNameError(`a${String.fromCharCode(code)}b`)).toBe(
        allowed ? undefined : copy.nameInvalidCharacters,
      );
    }
    expect(displayNameError('a\u007Fb')).toBeUndefined();
  });

  it('explains a password over the limit', () => {
    expect(signUpErrorMessage({ code: 'PASSWORD_TOO_LONG' })).toBe('Use 128 characters or fewer.');
  });

  it('tells an unverified user to check their inbox', () => {
    expect(signInErrorMessage({ code: 'EMAIL_NOT_VERIFIED', status: 403 })).toBe(
      'Verify your email first. Check your inbox for the link.',
    );
  });

  it.each([signInErrorMessage, signUpErrorMessage])(
    'explains rate limiting on HTTP 429',
    (message) => {
      expect(message({ status: 429 })).toBe('Too many attempts. Wait a minute and try again.');
    },
  );

  it('maps sign-in errors without saying which half was wrong', () => {
    expect(signInErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })).toBe(
      "That email and password don't match.",
    );
    expect(signInErrorMessage({ status: 401 })).toBe(copy.wrongCredentials);
    expect(signInErrorMessage({ status: 503 })).toBe(copy.signInFailed);
  });

  it('checks the rough shape of an email', () => {
    expect(looksLikeEmail(' ana@example.test ')).toBe(true);
    expect(looksLikeEmail('ana@example')).toBe(false);
    expect(looksLikeEmail('ana example.test')).toBe(false);
  });
});

describe('two-factor and reset copy', () => {
  it('explains a rejected code without more detail', () => {
    expect(twoFactorErrorMessage({ code: 'INVALID_CODE', status: 401 })).toBe(
      copy.twoFactorInvalid,
    );
    expect(twoFactorErrorMessage({ code: 'INVALID_BACKUP_CODE', status: 401 })).toBe(
      copy.twoFactorInvalid,
    );
    expect(twoFactorErrorMessage({ status: 429 })).toBe(copy.tooManyAttempts);
    expect(twoFactorErrorMessage({ code: 'ACCOUNT_TEMPORARILY_LOCKED', status: 403 })).toBe(
      copy.tooManyAttempts,
    );
    expect(twoFactorErrorMessage({ status: 500 })).toBe(copy.twoFactorFailed);
  });

  it('tells the user to sign in again when the challenge itself expired', () => {
    expect(twoFactorErrorMessage({ code: 'INVALID_TWO_FACTOR_COOKIE', status: 401 })).toBe(
      copy.twoFactorExpired,
    );
  });

  it('maps a wrong password on a security action', () => {
    expect(securityErrorMessage({ code: 'INVALID_PASSWORD', status: 400 })).toBe(
      copy.passwordIncorrect,
    );
    expect(securityErrorMessage({ status: 429 })).toBe(copy.tooManyAttempts);
    expect(securityErrorMessage({ status: 500 })).toBe(copy.securityFailed);
  });

  it('treats a bad or expired reset token as an invalid link', () => {
    expect(resetErrorMessage({ code: 'INVALID_TOKEN', status: 400 })).toBe(copy.resetLinkInvalid);
    expect(resetErrorMessage({ status: 400 })).toBe(copy.resetLinkInvalid);
    expect(resetErrorMessage({ status: 429 })).toBe(copy.tooManyAttempts);
    expect(resetErrorMessage({ code: 'PASSWORD_TOO_SHORT', status: 400 })).toBe(
      copy.passwordTooShort,
    );
    expect(resetErrorMessage({ status: 500 })).toBe(copy.resetFailed);
  });

  it('checks a new password and its confirmation', () => {
    expect(validateNewPassword('long-enough-password', 'long-enough-password')).toEqual({});
    expect(validateNewPassword('short', 'short')).toEqual({ password: copy.passwordTooShort });
    expect(validateNewPassword('long-enough-password', 'something-else-here')).toEqual({
      confirm: copy.passwordMismatch,
    });
    expect(validateNewPassword('short', 'different')).toEqual({
      password: copy.passwordTooShort,
      confirm: copy.passwordMismatch,
    });
    expect(validateNewPassword('x'.repeat(129), 'x'.repeat(129))).toEqual({
      password: copy.passwordTooLong,
    });
  });
});

/** The fields of a Better Auth client error this app reads. */
export interface AuthErrorLike {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
/** The server's display-name rule (`PATCH /api/v1/me` and sign-up): 1 to 120 UTF-16 units. */
export const MAX_NAME_LENGTH = 120;

export const copy = {
  passwordRule: `At least ${MIN_PASSWORD_LENGTH} characters.`,
  passwordTooShort: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  passwordTooLong: `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`,
  passwordRequired: 'Enter your password.',
  nameRequired: 'Tell us what to call you.',
  nameTooLong: `Use ${MAX_NAME_LENGTH} characters or fewer.`,
  nameInvalidCharacters: 'Remove the hidden control characters from your name.',
  nameRejected: `Use 1 to ${MAX_NAME_LENGTH} characters, without hidden control characters.`,
  emailInvalid: 'Enter an email address like name@company.com.',
  emailTaken: 'That email is already registered.',
  signUpFailed: 'We could not create your account. Try again in a moment.',
  wrongCredentials: "That email and password don't match.",
  signInFailed: 'We could not sign you in. Try again in a moment.',
  signOutFailed: 'We could not sign you out. Try again.',
  sessionExpired: 'Your session ended. Sign in again to continue.',
  emailNotVerified: 'Verify your email first. Check your inbox for the link.',
  tooManyAttempts: 'Too many attempts. Wait a minute and try again.',
  unreachableTitle: "We can't reach KNOQRA right now",
  unreachableBody: 'Check your connection, then try again. Your work is safe.',
  retry: 'Try again',
  cancel: 'Cancel',
  passwordMismatch: "The two passwords don't match.",
  passwordIncorrect: 'That password is not right.',
  twoFactorInvalid: "That code didn't work. Check it and try again.",
  twoFactorExpired: 'That sign-in timed out. Go back and sign in again.',
  twoFactorFailed: 'We could not check that code. Try again in a moment.',
  securityFailed: 'We could not make that change. Try again in a moment.',
  resetLinkInvalid: 'This reset link is invalid or has expired. Request a new one.',
  resetFailed: 'We could not reset your password. Try again in a moment.',
  resetLinkIncomplete: 'This reset link is incomplete. Request a new one.',
  resetSent: 'If an account exists, a reset link is on its way.',
  resetRequestFailed: 'We could not send that. Try again in a moment.',
  resetDone: 'Password updated. Sign in with your new password.',
} as const;

// NUL and the other C0 control characters except tab, line feed and carriage return: the same
// set as the API's `isSafeText` (apps/api/src/lib/schemas.ts), which refuses them with a 400.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * The server's display-name rule, checked before submitting: trimmed, 1 to 120 characters
 * counted as `string.length` (as zod does), and no control characters. Undefined when valid.
 */
export function displayNameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return copy.nameRequired;
  if (trimmed.length > MAX_NAME_LENGTH) return copy.nameTooLong;
  if (UNSAFE_TEXT.test(trimmed)) return copy.nameInvalidCharacters;
  return undefined;
}

/** The sign-up hook answers 400 with "Name must be ..." and no specific code. */
const NAME_REFUSED = /\bname\b/i;

export function signUpErrorMessage(error: AuthErrorLike): string {
  if (error.status === 429) return copy.tooManyAttempts;
  if (error.status === 400 && NAME_REFUSED.test(error.message ?? '')) return copy.nameRejected;
  if (error.code === 'PASSWORD_TOO_LONG') return copy.passwordTooLong;
  if (error.code?.startsWith('USER_ALREADY_EXISTS')) return copy.emailTaken;
  if (error.code === 'PASSWORD_TOO_SHORT') return copy.passwordTooShort;
  if (error.code === 'INVALID_EMAIL') return copy.emailInvalid;
  return copy.signUpFailed;
}

/** The sign-up field a message belongs on, or null for a form-level error. */
export function signUpErrorField(message: string): 'name' | 'password' | null {
  if (message === copy.nameRejected) return 'name';
  if (message === copy.passwordTooShort || message === copy.passwordTooLong) return 'password';
  return null;
}

export function signInErrorMessage(error: AuthErrorLike): string {
  if (error.status === 429) return copy.tooManyAttempts;
  if (error.code === 'EMAIL_NOT_VERIFIED') return copy.emailNotVerified;
  if (error.code === 'INVALID_EMAIL_OR_PASSWORD' || error.status === 401) {
    return copy.wrongCredentials;
  }
  if (error.code === 'INVALID_EMAIL') return copy.emailInvalid;
  return copy.signInFailed;
}

const TWO_FACTOR_CODE_ERRORS = new Set(['INVALID_CODE', 'INVALID_BACKUP_CODE']);
const LOCKED_ERRORS = new Set(['ACCOUNT_TEMPORARILY_LOCKED', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE']);

/** A TOTP or backup code that Better Auth would not accept at the sign-in challenge. */
export function twoFactorErrorMessage(error: AuthErrorLike): string {
  if (error.status === 429 || (error.code && LOCKED_ERRORS.has(error.code))) {
    return copy.tooManyAttempts;
  }
  if (error.code === 'INVALID_TWO_FACTOR_COOKIE') return copy.twoFactorExpired;
  if (error.code && TWO_FACTOR_CODE_ERRORS.has(error.code)) return copy.twoFactorInvalid;
  return copy.twoFactorFailed;
}

/** A password-confirmed security action (enable, disable, new backup codes) that failed. */
export function securityErrorMessage(error: AuthErrorLike): string {
  if (error.status === 429) return copy.tooManyAttempts;
  if (error.code === 'INVALID_PASSWORD') return copy.passwordIncorrect;
  return copy.securityFailed;
}

/** The reset-password call failed: a 400 means the token is bad or used up. */
export function resetErrorMessage(error: AuthErrorLike): string {
  if (error.status === 429) return copy.tooManyAttempts;
  if (error.code === 'PASSWORD_TOO_SHORT') return copy.passwordTooShort;
  if (error.code === 'PASSWORD_TOO_LONG') return copy.passwordTooLong;
  if (error.code === 'INVALID_TOKEN' || error.status === 400) return copy.resetLinkInvalid;
  return copy.resetFailed;
}

export interface NewPasswordErrors {
  password?: string;
  confirm?: string;
}

/** Client-side check of the reset form; the server enforces the same length. */
export function validateNewPassword(password: string, confirm: string): NewPasswordErrors {
  const errors: NewPasswordErrors = {};
  if (password.length < MIN_PASSWORD_LENGTH) errors.password = copy.passwordTooShort;
  else if (password.length > MAX_PASSWORD_LENGTH) errors.password = copy.passwordTooLong;
  if (password !== confirm) errors.confirm = copy.passwordMismatch;
  return errors;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

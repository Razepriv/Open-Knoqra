/** The shared secret inside an `otpauth://` URI, or null when the URI has none. */
export function secretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret') || null;
  } catch {
    return null;
  }
}

/** "JBSW Y3DP EHPK 3PXP": easier to read and to type into an authenticator app. */
export function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/** A pasted code often carries spaces; nothing else is changed (backup codes keep their dash). */
export function normalizeCode(value: string): string {
  return value.replace(/\s+/g, '');
}

/** The text of the downloadable backup-codes file. */
export function backupCodesFile(codes: readonly string[]): string {
  return [
    'KNOQRA backup codes',
    '',
    'Each code works once. Keep them somewhere safe: anyone with a code and your password',
    'can sign in. You will not be shown them again.',
    '',
    codes.join('\n'),
    '',
  ].join('\n');
}

/** True when a sign-in answer says the password was right but a second factor is still needed. */
export function needsTwoFactor(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    'twoFactorRedirect' in data &&
    data.twoFactorRedirect === true
  );
}

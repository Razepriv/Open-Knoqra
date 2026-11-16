import type { ChannelPermission } from './contact360';

/** Same bounds as the API's `reason` (5 to 500 characters, after trimming). */
export const MIN_REASON_LENGTH = 5;
export const MAX_REASON_LENGTH = 500;

/** The API's 422 code when a do-not-contact channel is granted without a reason. */
export const REASON_REQUIRED_CODE = 'consent_reason_required';

/**
 * Owner rule (2026-11-13): granting a channel whose current status is `do_not_contact` lifts it,
 * and that needs a written reason. Every other change keeps the optional evidence note.
 */
export function liftsDoNotContact(
  current: ChannelPermission['status'] | undefined,
  action: string,
): boolean {
  return current === 'do_not_contact' && action === 'granted';
}

/** The field error for a lift reason, or null when it can be sent. */
export function liftReasonError(text: string): string | null {
  const length = text.trim().length;
  if (length === 0) return 'Add how they gave consent again.';
  if (length < MIN_REASON_LENGTH) {
    return `Use at least ${MIN_REASON_LENGTH} characters.`;
  }
  if (length > MAX_REASON_LENGTH) return `Use ${MAX_REASON_LENGTH} characters or fewer.`;
  return null;
}

/** "12 / 500": the character count shown under the reason field. */
export function reasonCount(text: string): string {
  return `${text.trim().length} / ${MAX_REASON_LENGTH}`;
}

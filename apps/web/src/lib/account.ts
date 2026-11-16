import { api, throwIfFailed } from './api';

/**
 * Deletes the signed-in user's account (`DELETE /api/v1/me`), confirmed with their password. A
 * workspace only they use is closed; in a workspace with another owner the data stays. Every
 * session ends. Throws an ApiError: `invalid_password` (400), `sole_owner_with_members` (409), or
 * `provider_unavailable` (502, nothing was deleted).
 */
export async function deleteAccount(password: string): Promise<void> {
  throwIfFailed(
    await api.DELETE('/api/v1/me', { body: { password } }),
    'Your account could not be deleted. Try again in a moment.',
  );
}

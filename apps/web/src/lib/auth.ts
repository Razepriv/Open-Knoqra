import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { classifySession, type SessionState } from './session-state';

/**
 * Better Auth on the same origin: /api/auth/* is proxied to the API (Vite in dev, a service
 * binding in production), so the session cookie is first-party.
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [organizationClient(), twoFactorClient()],
});

type SessionResult = Awaited<ReturnType<typeof authClient.getSession>>;
export type Session = NonNullable<SessionResult['data']>;

/**
 * The current session. Uses /api/auth/get-session, which also refreshes the session cookie, so
 * routes are gated on this rather than on /api/v1/me.
 *
 * `unauthenticated` means the server answered that nobody is signed in. `unreachable` means it
 * could not be asked (network failure, 5xx), so routes show the outage state instead of
 * redirecting a possibly signed-in user to sign-in.
 */
export async function currentSession(): Promise<SessionState<Session>> {
  try {
    return classifySession<Session>(await authClient.getSession());
  } catch {
    return { status: 'unreachable' };
  }
}

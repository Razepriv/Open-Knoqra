import { relativeTime } from './format';
import { describeDevice } from './user-agent';

/** The fields of a Better Auth session this screen reads. */
export interface SessionEntry {
  id: string;
  token: string;
  userAgent?: string | null | undefined;
  ipAddress?: string | null | undefined;
  updatedAt: Date;
  createdAt: Date;
}

export interface SessionRow {
  id: string;
  /** Needed to revoke the session; never rendered. */
  token: string;
  current: boolean;
  device: string;
  ip: string | null;
  lastActive: Date;
}

/**
 * The token of the signed-in session from a Better Auth `getSession` result, or null when it is
 * not known (no session, an error, a malformed answer). Callers must treat null as "unknown".
 */
export function currentSessionToken(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || !('data' in result)) return null;
  const { data } = result as { data: unknown };
  if (typeof data !== 'object' || data === null || !('session' in data)) return null;
  const { session } = data as { session: unknown };
  if (typeof session !== 'object' || session === null || !('token' in session)) return null;
  const { token } = session as { token: unknown };
  return typeof token === 'string' && token ? token : null;
}

/**
 * The signed-in device first, then the most recently active others. Fails closed: without a known
 * current token that appears in the list, no row could be told apart as "this device", and every
 * row would offer Revoke, including the one the user is signed in on.
 */
export function toSessionRows(
  sessions: readonly SessionEntry[],
  currentToken: string,
): SessionRow[] {
  if (!currentToken || !sessions.some((entry) => entry.token === currentToken)) {
    throw new Error('The current session is unknown, so the device list cannot be shown.');
  }
  return sessions
    .map((entry) => ({
      id: entry.id,
      token: entry.token,
      current: entry.token === currentToken,
      device: describeDevice(entry.userAgent).label,
      ip: entry.ipAddress || null,
      lastActive: new Date(entry.updatedAt),
    }))
    .sort((x, y) => {
      if (x.current !== y.current) return x.current ? -1 : 1;
      return y.lastActive.getTime() - x.lastActive.getTime();
    });
}

/** Query key of the signed-in user's device list; refetch it after anything that rotates the session. */
export const sessionsKey = ['auth', 'sessions'] as const;

/** Accessible name for a row's Revoke button: device, address and last activity tell rows apart. */
export function revokeLabel(row: SessionRow, now: Date = new Date(), locale?: string): string {
  const parts = [
    row.device,
    ...(row.ip ? [row.ip] : []),
    relativeTime(row.lastActive, now, locale),
  ];
  return `Revoke ${parts.join(', ')}`;
}

import type { Env } from '../env';
import { logger } from './logger';

/** Header the Worker route sets, after authenticating, to tag a socket with its user. */
export const REALTIME_USER_HEADER = 'x-knoqra-user';

/** Server-to-client realtime frames, sent as JSON. M3 adds `message.*` types. */
export type RealtimeMessage =
  | { type: 'call.updated'; data: unknown }
  | { type: 'wallet.updated'; data: unknown }
  | { type: 'voicemail.created'; data: unknown };

/**
 * Sends `message` to every socket connected for the organization. Best effort: realtime is a
 * notification channel, never the source of truth, so a failure is logged (org id only, never the
 * payload) and swallowed.
 */
export async function publish(env: Env, orgId: string, message: RealtimeMessage): Promise<void> {
  try {
    const stub = env.ORG_REALTIME.get(env.ORG_REALTIME.idFromName(orgId));
    await stub.broadcast(message);
  } catch (error) {
    logger.error('realtime.publish_failed', { orgId, error });
  }
}

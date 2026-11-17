import type { Env } from '../env';
import { logger } from './logger';

/** Header the Worker route sets, after authenticating, to tag a socket with its user. */
export const REALTIME_USER_HEADER = 'x-knoqra-user';

/**
 * Server-to-client realtime frames, sent as JSON. `message.updated` carries a whole `Message` (new
 * or changed: status, attachment stored, reaction); `conversation.updated` names a conversation
 * whose summary changed; `channels.updated` says a channel's status changed (Enable flows, sync).
 */
export type RealtimeMessage =
  | { type: 'call.updated'; data: unknown }
  | { type: 'wallet.updated'; data: unknown }
  | { type: 'voicemail.created'; data: unknown }
  | { type: 'message.updated'; data: { conversationId: string; message: unknown } }
  | { type: 'conversation.updated'; data: { conversationId: string } }
  | { type: 'channels.updated'; data: Record<string, never> }
  /**
   * A frame an edition's extension sends (`ext.<name>`). The core Desk hands it to the listeners
   * the extension registered (apps/web/src/lib/realtime.ts) and does nothing else with it.
   */
  | { type: `ext.${string}`; data: unknown };

/**
 * Sends `message` to every socket connected for the organization, or with `userId` only to that
 * member's sockets. Best effort: realtime is a notification channel, never the source of truth,
 * so a failure is logged (org id only, never the payload) and swallowed.
 */
export async function publish(
  env: Env,
  orgId: string,
  message: RealtimeMessage,
  opts: { userId?: string } = {},
): Promise<void> {
  try {
    const stub = env.ORG_REALTIME.get(env.ORG_REALTIME.idFromName(orgId));
    await stub.broadcast(message, opts.userId);
  } catch (error) {
    logger.error('realtime.publish_failed', { orgId, error });
  }
}

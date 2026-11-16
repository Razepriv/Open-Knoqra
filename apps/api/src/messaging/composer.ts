import {
  type ComposerState,
  composerState,
  MESSAGING_CHANNELS,
  type MessagingChannel,
  type PermissionStatus,
} from '@knoqra/core';
import { channelConnection, contactPermissionEvent, type Tx } from '@knoqra/db';
import { and, desc, inArray } from 'drizzle-orm';
import type { Env } from '../env';
import { credentialFor, type Sender, toSender } from './senders';
import type { ConversationRow } from './store';

/**
 * Composer state for a page of conversations without per-row queries: one query for the latest
 * permission per (contact, channel), one for the senders of the channels in use, and the Telnyx
 * credential check at most once, only when one of those senders is telnyx (pass `hasCredential`
 * when the caller already loaded it).
 */
export async function composerFor(
  tx: Tx,
  env: Env,
  conversations: ConversationRow[],
  now: Date,
  hasCredential?: boolean,
): Promise<Map<string, ComposerState>> {
  const result = new Map<string, ComposerState>();
  if (conversations.length === 0) return result;

  const contactIds = [...new Set(conversations.map((c) => c.contactId))];
  const rows = await tx
    .selectDistinctOn([contactPermissionEvent.contactId, contactPermissionEvent.channel])
    .from(contactPermissionEvent)
    .where(
      and(
        inArray(contactPermissionEvent.contactId, contactIds),
        inArray(contactPermissionEvent.channel, [...MESSAGING_CHANNELS]),
      ),
    )
    .orderBy(
      contactPermissionEvent.contactId,
      contactPermissionEvent.channel,
      desc(contactPermissionEvent.createdAt),
      desc(contactPermissionEvent.id),
    );
  const consent = new Map<string, PermissionStatus>();
  for (const row of rows) consent.set(`${row.contactId}:${row.channel}`, row.status);

  const channels = [...new Set(conversations.map((c) => c.channel))];
  const connections = await tx
    .select()
    .from(channelConnection)
    .where(inArray(channelConnection.channel, channels));
  const credential = await credentialFor(tx, connections, hasCredential);
  const senders = new Map<MessagingChannel, Sender>();
  for (const row of connections) senders.set(row.channel, toSender(row, env, credential));

  for (const conv of conversations) {
    result.set(
      conv.id,
      composerState({
        channel: conv.channel,
        consent: consent.get(`${conv.contactId}:${conv.channel}`),
        sender: senders.get(conv.channel) ?? null,
        lastInboundAt: conv.lastInboundAt,
        now,
      }),
    );
  }
  return result;
}

import {
  contact,
  conversation,
  createDb,
  type Database,
  message,
  messageReaction,
  withTenant,
} from '@knoqra/db';
import type { MessagingProvider } from '@knoqra/providers';
import { TelnyxMessagingError } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { connectionString, type Env } from '../env';
import type { Tenant } from '../lib/context';
import type { ErrorCode } from '../lib/envelope';
import { logger } from '../lib/logger';
import { insertMessagingAudit } from './audit';
import { composerFor } from './composer';
import { isReplyable, type MessageJson } from './json';
import { loadMessageJson, publishMessage } from './send';
import { hasTelnyxCredential, messagingProviderFor, senderFor } from './senders';

/** WhatsApp accepts reactions to messages up to 30 days old (Meta's reaction-messages guide). */
export const REACTION_MAX_AGE_MS = 30 * 86_400_000;
const MESSAGE_ID_PATTERN = /^mg_[0-9a-f]{32}$/;
/** One emoji (a grapheme can be several code points: skin tones, joiners, flags). */
const MAX_EMOJI_LENGTH = 32;

export interface ReactionDeps {
  db: Database;
  env: Env;
  tenant: Tenant;
  /** Tests inject a provider; null means none. */
  provider?: MessagingProvider | null;
  fetch?: typeof fetch;
  /** Sends after the response; absent, before `setReaction` returns. */
  background?: (task: Promise<unknown>) => void;
}

export type ReactionResult =
  | { kind: 'ok'; message: MessageJson }
  | { kind: 'error'; status: 404 | 422; code: ErrorCode; message: string };

const refusal = (status: 404 | 422, code: ErrorCode, text: string): ReactionResult => ({
  kind: 'error',
  status,
  code,
  message: text,
});

/** Pictographs, emoji components (skin tones, keycaps), joiners and variation selectors. */
const EMOJI_PART =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\u{200d}|\u{fe0f}|\u{20e3})+$/u;

/** Whether `emoji` is one short emoji-like token (not text, not a URL). */
export function isEmoji(emoji: string): boolean {
  if (emoji.length === 0 || emoji.length > MAX_EMOJI_LENGTH) return false;
  return EMOJI_PART.test(emoji) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji);
}

interface Planned {
  json: MessageJson;
  send: {
    provider: MessagingProvider;
    from: string;
    to: string;
    target: string;
    emoji: string;
    reactionId: string | null;
  };
}

/**
 * Sets (or, with an empty emoji, removes) the workspace's reaction to an inbound WhatsApp message.
 * The reaction is stored at once as pending and sent to the provider afterwards; the outcome lands
 * on the reaction (sent or failed) and is published. Needs the conversation's composer to allow
 * free messages (WhatsApp's 24-hour window) and a message under 30 days old.
 */
export async function setReaction(
  deps: ReactionDeps,
  messageId: string,
  emoji: string,
): Promise<ReactionResult> {
  const { db, env, tenant } = deps;
  const notFound = refusal(404, 'not_found', 'Message not found.');
  if (!MESSAGE_ID_PATTERN.test(messageId)) return notFound;
  if (emoji !== '' && !isEmoji(emoji)) {
    return refusal(422, 'validation_error', 'emoji: Choose one emoji.');
  }

  const planned = await withTenant(
    db,
    tenant.orgId,
    async (tx): Promise<Planned | ReactionResult> => {
      const [row] = await tx
        .select()
        .from(message)
        .where(eq(message.id, messageId))
        .limit(1)
        .for('update');
      if (!row) return notFound;
      if (!isReplyable(row) || row.channelMessageId === null) {
        return refusal(
          422,
          'validation_error',
          "You can react only to a contact's WhatsApp messages.",
        );
      }
      if (Date.now() - row.occurredAt.getTime() > REACTION_MAX_AGE_MS) {
        return refusal(422, 'validation_error', 'WhatsApp allows reactions only within 30 days.');
      }
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, row.conversationId))
        .limit(1);
      if (!conv) return notFound;
      const credential = await hasTelnyxCredential(tx);
      const state = (await composerFor(tx, env, [conv], new Date(), credential)).get(conv.id);
      if (state?.mode !== 'free') {
        return refusal(
          422,
          state?.mode === 'template_only' ? 'template_required' : 'send_paused',
          state?.mode === 'template_only'
            ? 'The 24-hour WhatsApp window is closed, so reactions cannot be sent.'
            : 'Sending is not available on this conversation.',
        );
      }
      const sender = await senderFor(tx, env, 'whatsapp', credential);
      const provider =
        deps.provider !== undefined
          ? deps.provider
          : sender
            ? await messagingProviderFor(tx, sender, env, deps.fetch)
            : null;
      if (!sender || !provider?.sendWhatsAppReaction) {
        return refusal(422, 'send_paused', 'Sending is not available on this conversation.');
      }
      const [recipient] = await tx
        .select({ phone: contact.phoneE164 })
        .from(contact)
        .where(eq(contact.id, conv.contactId))
        .limit(1);
      if (!recipient) return notFound;

      let reactionId: string | null = null;
      if (emoji === '') {
        await tx
          .delete(messageReaction)
          .where(
            and(eq(messageReaction.messageId, row.id), eq(messageReaction.direction, 'outbound')),
          );
      } else {
        const [saved] = await tx
          .insert(messageReaction)
          .values({
            organizationId: tenant.orgId,
            messageId: row.id,
            direction: 'outbound',
            emoji,
            status: 'pending',
            actorUserId: tenant.userId,
          })
          .onConflictDoUpdate({
            target: [messageReaction.messageId, messageReaction.direction],
            set: { emoji, status: 'pending', actorUserId: tenant.userId, errorMessage: null },
          })
          .returning({ id: messageReaction.id });
        reactionId = saved?.id ?? null;
      }
      await insertMessagingAudit(tx, tenant, {
        action: 'reaction.send',
        entityType: 'message',
        outcome: 'allowed',
        entityId: row.id,
        metadata: { removed: emoji === '' },
      });
      const json = await loadMessageJson(tx, env, row.id);
      if (!json) return notFound;
      return {
        json,
        send: {
          provider,
          from: sender.address,
          to: recipient.phone,
          target: row.channelMessageId,
          emoji,
          reactionId,
        },
      };
    },
  );
  if ('kind' in planned) return planned;

  const task = deliverReaction(env, tenant.orgId, messageId, planned.send);
  if (deps.background) {
    deps.background(task);
    return { kind: 'ok', message: planned.json };
  }
  const after = await task;
  return { kind: 'ok', message: after ?? planned.json };
}

/** Sends the reaction, records sent or failed (unless it changed meanwhile) and publishes. */
async function deliverReaction(
  env: Env,
  orgId: string,
  messageId: string,
  send: Planned['send'],
): Promise<MessageJson | undefined> {
  let failure: string | null = null;
  try {
    await send.provider.sendWhatsAppReaction?.({
      orgId,
      from: send.from,
      to: send.to,
      targetChannelMessageId: send.target,
      emoji: send.emoji,
      idempotencyKey: crypto.randomUUID(),
    });
  } catch (error) {
    failure =
      error instanceof TelnyxMessagingError
        ? error.failure.message
        : 'The reaction could not be sent.';
    logger.warn('messaging.reaction_failed', {
      messageId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  const handle = createDb(connectionString(env));
  try {
    const json = await withTenant(handle.db, orgId, async (tx) => {
      if (send.reactionId) {
        await tx
          .update(messageReaction)
          .set(
            failure
              ? { status: 'failed', errorMessage: failure }
              : { status: 'sent', errorMessage: null },
          )
          .where(
            and(eq(messageReaction.id, send.reactionId), eq(messageReaction.emoji, send.emoji)),
          );
      }
      return loadMessageJson(tx, env, messageId);
    });
    if (json) await publishMessage(env, orgId, json);
    return json;
  } catch (error) {
    logger.error('messaging.reaction_record_failed', { messageId, error });
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

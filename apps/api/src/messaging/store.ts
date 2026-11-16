import {
  currentPermissions,
  type MessageStatus,
  type MessagingChannel,
  nextStatus,
} from '@knoqra/core';
import {
  type Conversation,
  contactPermissionEvent,
  conversation,
  type Message,
  type MessageProvider,
  message,
  messageStatusEvent,
  type Tx,
  timelineEvent,
} from '@knoqra/db';
import type { MessageFailure } from '@knoqra/providers';
import { and, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { findContact } from '../lib/contact-access';
import { latestPermissionEvents } from '../lib/permissions';
import { settleMessageCost } from './cost';

export type ConversationRow = Conversation;
export type MessageRow = Message;

const PREVIEW_CHARS = 140;
const TIMELINE_BODY_CHARS = 280;

const CHANNEL_LABELS: Record<MessagingChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

/** First `n` characters by code point, so a surrogate pair is never split. */
const firstChars = (text: string, n: number): string => Array.from(text).slice(0, n).join('');

/** The conversation for (contact, channel), created on first use. Safe under concurrent callers. */
export async function ensureConversation(
  tx: Tx,
  orgId: string,
  contactId: string,
  channel: MessagingChannel,
): Promise<ConversationRow> {
  await tx
    .insert(conversation)
    .values({ organizationId: orgId, contactId, channel })
    .onConflictDoNothing({
      target: [conversation.organizationId, conversation.contactId, conversation.channel],
    });
  const [row] = await tx
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, contactId),
        eq(conversation.channel, channel),
      ),
    )
    .limit(1);
  if (!row) throw new Error('conversation upsert returned no row');
  return row;
}

/** True when no other message of the conversation sorts after this one by (occurred_at, id). */
async function isLatestMessage(tx: Tx, conversationId: string, messageId: string) {
  const rows = await tx.execute<{ latest: boolean }>(sql`
    select not exists (
      select 1 from ${message} m
      where m.conversation_id = ${conversationId}
        and (m.occurred_at, m.id) > (
          select occurred_at, id from ${message} where id = ${messageId}
        )
    ) as latest`);
  return rows.rows[0]?.latest === true;
}

export interface InsertMessageInput {
  /** A pre-allocated `mg_` id (the send path needs it before the insert); generated if absent. */
  id?: string;
  orgId: string;
  conversation: ConversationRow;
  direction: 'inbound' | 'outbound';
  body: string;
  status: MessageStatus;
  provider: string;
  providerMessageId?: string | null;
  clientMessageId?: string | null;
  templateId?: string | null;
  authorUserId?: string | null;
  occurredAt: Date;
}

/**
 * Inserts a message and, in the same transaction, updates the conversation summary and appends
 * the contact timeline entry. The summary's preview, direction and status follow the latest
 * message by (occurred_at, id), so a late-arriving older message never overwrites them.
 */
export async function insertMessage(tx: Tx, input: InsertMessageInput): Promise<MessageRow> {
  const conv = input.conversation;
  const [row] = await tx
    .insert(message)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      organizationId: input.orgId,
      conversationId: conv.id,
      // message.contact_id has no FK: always the conversation's contact.
      contactId: conv.contactId,
      channel: conv.channel,
      direction: input.direction,
      body: input.body,
      templateId: input.templateId ?? null,
      status: input.status,
      // The provider column's CHECK constraint rejects unknown providers.
      provider: input.provider as MessageProvider,
      providerMessageId: input.providerMessageId ?? null,
      clientMessageId: input.clientMessageId ?? null,
      authorUserId: input.authorUserId ?? null,
      occurredAt: input.occurredAt,
    })
    .returning();
  if (!row) throw new Error('message insert returned no row');

  const latest = await isLatestMessage(tx, conv.id, row.id);
  const inbound = input.direction === 'inbound';
  await tx
    .update(conversation)
    .set({
      lastActivityAt: sql`greatest(${conversation.lastActivityAt}, ${input.occurredAt})`,
      ...(latest
        ? {
            lastMessagePreview: firstChars(input.body, PREVIEW_CHARS),
            lastMessageDirection: input.direction,
            lastMessageStatus: input.status,
          }
        : {}),
      ...(inbound
        ? {
            unreadCount: sql`${conversation.unreadCount} + 1`,
            lastInboundAt: sql`greatest(coalesce(${conversation.lastInboundAt}, ${input.occurredAt}), ${input.occurredAt})`,
          }
        : {}),
    })
    .where(eq(conversation.id, conv.id));

  await tx.insert(timelineEvent).values({
    organizationId: input.orgId,
    contactId: conv.contactId,
    kind: 'message',
    title: `${inbound ? 'Inbound' : 'Outbound'} ${CHANNEL_LABELS[conv.channel]}`,
    body: firstChars(input.body, TIMELINE_BODY_CHARS),
    actorUserId: input.authorUserId ?? null,
    source: inbound ? 'provider' : 'app',
    refType: 'message',
    refId: row.id,
    occurredAt: input.occurredAt,
  });
  return row;
}

export interface ApplyReceiptInput {
  orgId: string;
  providerMessageId: string;
  provider: string;
  incoming: MessageStatus;
  occurredAt: Date;
  rawEventId: string;
  error?: { code: string; message: string };
  /** A final `sent` receipt (ruling AS). */
  final?: boolean;
}

interface StatusUpdate {
  incoming: MessageStatus;
  occurredAt: Date;
  /** Null when the status did not come from a provider event (a send the provider refused). */
  rawEventId: string | null;
  error?: { code: string; message: string };
  /** A final `sent` receipt: the provider will say nothing further, so the hold is captured. */
  final?: boolean;
}

/**
 * A final `sent` receipt that did not move the message (it was already `sent`) still captures the
 * open hold: the earlier non-final `sent` applied the status but settled nothing. The capture key
 * makes a repeat a no-op, and a message that moved on (delivered, read, failed) is left alone.
 */
async function captureFinalSent(tx: Tx, current: MessageRow, input: StatusUpdate): Promise<void> {
  if (input.incoming !== 'sent' || input.final !== true || current.status !== 'sent') return;
  await settleMessageCost(tx, {
    orgId: current.organizationId,
    messageId: current.id,
    channel: current.channel,
    direction: current.direction,
    status: 'sent',
    final: true,
  });
}

/**
 * The status rules shared by receipts and the send path, for a message row the caller has locked:
 * every update is recorded in `message_status_event` with whether it changed the message
 * (`applied`); an applied one moves the message, the conversation's `lastMessageStatus` when the
 * message is the latest, settles its cost hold (capture on delivered or read, release on failed),
 * and a failure adds a "failed to deliver" timeline entry. Only the write that moved the message
 * settles, so a replayed or out-of-order receipt posts nothing to the ledger; the one exception is
 * a final `sent` on a message already `sent`, which captures once by key (ruling AS).
 */
async function applyStatus(
  tx: Tx,
  current: MessageRow,
  input: StatusUpdate,
): Promise<'applied' | 'ignored'> {
  const next = nextStatus(current.status, input.incoming);
  await tx.insert(messageStatusEvent).values({
    organizationId: current.organizationId,
    messageId: current.id,
    status: input.incoming,
    applied: next.changed,
    occurredAt: input.occurredAt,
    rawEventId: input.rawEventId,
    errorCode: input.error?.code ?? null,
  });
  if (!next.changed) {
    await captureFinalSent(tx, current, input);
    return 'ignored';
  }

  const failed = next.status === 'failed';
  await tx
    .update(message)
    .set({
      status: next.status,
      statusUpdatedAt: input.occurredAt,
      ...(failed
        ? { errorCode: input.error?.code ?? null, errorMessage: input.error?.message ?? null }
        : {}),
    })
    .where(eq(message.id, current.id));

  if (await isLatestMessage(tx, current.conversationId, current.id)) {
    await tx
      .update(conversation)
      .set({ lastMessageStatus: next.status })
      .where(eq(conversation.id, current.conversationId));
  }

  if (failed) {
    await tx.insert(timelineEvent).values({
      organizationId: current.organizationId,
      contactId: current.contactId,
      kind: 'message',
      title: `${CHANNEL_LABELS[current.channel]} failed to deliver`,
      body: input.error?.message ?? null,
      source: 'provider',
      refType: 'message',
      refId: current.id,
      occurredAt: input.occurredAt,
    });
  }
  await settleMessageCost(tx, {
    orgId: current.organizationId,
    messageId: current.id,
    channel: current.channel,
    direction: current.direction,
    status: next.status,
    final: input.final === true && next.status === 'sent',
  });
  return 'applied';
}

/** Applies a delivery receipt under the message row lock. */
export async function applyReceipt(
  tx: Tx,
  input: ApplyReceiptInput,
): Promise<'applied' | 'ignored' | 'unknown_message'> {
  const [current] = await tx
    .select()
    .from(message)
    .where(
      and(
        eq(message.provider, input.provider as MessageProvider),
        eq(message.providerMessageId, input.providerMessageId),
      ),
    )
    .limit(1)
    .for('update');
  if (!current) return 'unknown_message';
  return applyStatus(tx, current, input);
}

export const PROVIDER_ERROR = {
  code: 'provider_error',
  message: 'The provider did not accept the message.',
} as const;

/** Refused: `failure` when the provider said why (a Telnyx error), absent for any other throw. */
export type ProviderSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; failure?: MessageFailure };

/**
 * Telnyx refused a send because the recipient opted out (replied STOP to our number): record it as
 * the contact's consent on that channel, so the composer blocks further sends. Do not contact is
 * sticky and is never replaced. Consent writers hold the contact row lock and use clock_timestamp().
 */
async function recordReportedOptOut(tx: Tx, current: MessageRow): Promise<void> {
  const { organizationId, contactId, channel } = current;
  await findContact(tx, contactId, true);
  const status = currentPermissions(await latestPermissionEvents(tx, contactId))[channel];
  if (status === 'do_not_contact') return;
  const [event] = await tx
    .insert(contactPermissionEvent)
    .values({
      organizationId,
      contactId,
      channel,
      status: 'opted_out',
      source: 'system',
      evidence: 'Telnyx reported an opt-out',
      actorUserId: null,
      createdAt: sql`clock_timestamp()` as unknown as Date,
    })
    .returning({ id: contactPermissionEvent.id });
  if (!event) throw new Error('permission insert returned no row');
  await tx.insert(timelineEvent).values({
    organizationId,
    contactId,
    kind: 'consent',
    title: `${CHANNEL_LABELS[channel]} opted out (reported by Telnyx)`,
    source: 'provider',
    refType: 'contact_permission_event',
    refId: event.id,
    occurredAt: sql`clock_timestamp()`,
  });
}

async function lockMessage(tx: Tx, messageId: string): Promise<MessageRow> {
  const [row] = await tx
    .select()
    .from(message)
    .where(eq(message.id, messageId))
    .limit(1)
    .for('update');
  if (!row) throw new Error('sent message vanished before its provider result');
  return row;
}

/**
 * An opt-out writes consent, so it takes the contact lock before the message lock: the order
 * merge, ingest and the other consent writers use (contact, then conversation and message). The
 * contact id is read unlocked, the contact locked, then the message locked and its contact id
 * checked again; a merge that re-pointed the message in between is followed once. Should it move
 * again, the latest row is used: recordReportedOptOut still locks its contact.
 */
async function lockForOptOut(tx: Tx, messageId: string): Promise<MessageRow> {
  let row: MessageRow | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const [peek] = await tx
      .select({ contactId: message.contactId })
      .from(message)
      .where(eq(message.id, messageId))
      .limit(1);
    if (!peek) throw new Error('sent message vanished before its provider result');
    await findContact(tx, peek.contactId, true);
    row = await lockMessage(tx, messageId);
    if (row.contactId === peek.contactId) return row;
  }
  if (!row) throw new Error('sent message vanished before its provider result');
  return row;
}

/**
 * Records what the provider said about a send. Accepted: stores the provider message id (the
 * status stays `queued` until receipts arrive). Refused: applies `failed` through the same status
 * rules as a receipt, with the provider's reason when it gave one (else `provider_error`); a
 * reported opt-out also records the contact's consent in this transaction, once per message.
 */
export async function recordProviderResult(
  tx: Tx,
  messageId: string,
  result: ProviderSendResult,
): Promise<void> {
  if (result.ok) {
    await tx
      .update(message)
      .set({ providerMessageId: result.providerMessageId })
      .where(and(eq(message.id, messageId), isNull(message.providerMessageId)));
    return;
  }
  const current =
    result.failure?.code === 'opted_out'
      ? await lockForOptOut(tx, messageId)
      : await lockMessage(tx, messageId);
  const error = result.failure
    ? { code: result.failure.code, message: result.failure.message }
    : PROVIDER_ERROR;
  const outcome = await applyStatus(tx, current, {
    incoming: 'failed',
    occurredAt: new Date(),
    rawEventId: null,
    error,
  });
  // Only the write that moved the message records the opt-out: a repeat must not append it again.
  if (outcome === 'applied' && result.failure?.code === 'opted_out') {
    await recordReportedOptOut(tx, current);
  }
}

/** A source thread whose target has no thread on that channel: it changes owner, nothing else. */
async function reassignConversation(tx: Tx, source: ConversationRow, targetId: string) {
  await tx.update(conversation).set({ contactId: targetId }).where(eq(conversation.id, source.id));
  await tx
    .update(message)
    .set({ contactId: targetId })
    .where(eq(message.conversationId, source.id));
}

/**
 * Both contacts hold a thread on the channel: the source's messages move into the target's thread,
 * whose summary is recomputed from its messages (latest by (occurred_at, id) for the preview,
 * direction and status; newest inbound for the window); unread counts add up. The emptied source
 * thread is deleted. Message ids do not change, so delivery history keeps pointing at them.
 */
async function foldConversation(tx: Tx, source: ConversationRow, kept: ConversationRow) {
  await tx
    .update(message)
    .set({ conversationId: kept.id, contactId: kept.contactId })
    .where(eq(message.conversationId, source.id));
  const [latest] = await tx
    .select({ body: message.body, direction: message.direction, status: message.status })
    .from(message)
    .where(eq(message.conversationId, kept.id))
    .orderBy(desc(message.occurredAt), desc(message.id))
    .limit(1);
  const [inbound] = await tx
    .select({ at: sql<Date | null>`max(${message.occurredAt})`.mapWith(message.occurredAt) })
    .from(message)
    .where(and(eq(message.conversationId, kept.id), eq(message.direction, 'inbound')));
  await tx
    .update(conversation)
    .set({
      // Both values already cover their own messages and the thread's creation.
      lastActivityAt: sql`greatest(${conversation.lastActivityAt}, ${source.lastActivityAt})`,
      lastInboundAt: inbound?.at ?? null,
      unreadCount: sql`${conversation.unreadCount} + ${source.unreadCount}`,
      ...(latest
        ? {
            lastMessagePreview: firstChars(latest.body, PREVIEW_CHARS),
            lastMessageDirection: latest.direction,
            lastMessageStatus: latest.status,
          }
        : {}),
    })
    .where(eq(conversation.id, kept.id));
  // message → conversation cascades on delete: only an emptied thread may go.
  const deleted = await tx
    .delete(conversation)
    .where(
      and(
        eq(conversation.id, source.id),
        notExists(
          tx.select({ one: sql`1` }).from(message).where(eq(message.conversationId, source.id)),
        ),
      ),
    )
    .returning({ id: conversation.id });
  if (deleted.length !== 1) throw new Error('folded conversation still holds messages');
}

/** Conversation ids a merge touched: re-pointed whole (`moved`) or folded into a target thread. */
export interface MergedConversations {
  moved: string[];
  folded: { from: string; into: string }[];
}

/**
 * Part of a contact merge, in the merge transaction (both contact rows already locked): every
 * thread of the source moves to the target, so the inbox shows one thread per channel and an
 * inbound to the source's old number (which ingest follows to the target) finds it. The thread
 * rows are locked in id order first, so a concurrent message insert waits for the move.
 */
export async function moveConversationsOnMerge(
  tx: Tx,
  orgId: string,
  targetId: string,
  sourceId: string,
): Promise<MergedConversations> {
  const rows = await tx
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        inArray(conversation.contactId, [targetId, sourceId]),
      ),
    )
    .orderBy(sql`${conversation.id} collate "C"`)
    .for('update');
  const targetThreads = new Map(
    rows.filter((r) => r.contactId === targetId).map((r) => [r.channel, r] as const),
  );
  const moved: string[] = [];
  const folded: { from: string; into: string }[] = [];
  for (const source of rows.filter((r) => r.contactId === sourceId)) {
    const kept = targetThreads.get(source.channel);
    if (kept) {
      await foldConversation(tx, source, kept);
      folded.push({ from: source.id, into: kept.id });
    } else {
      await reassignConversation(tx, source, targetId);
      moved.push(source.id);
    }
  }
  return { moved, folded };
}

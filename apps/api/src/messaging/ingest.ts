import {
  classifyKeyword,
  currentPermissions,
  type MessageStatus,
  type MessagingChannel,
  normalizePhone,
} from '@knoqra/core';
import {
  type Contact,
  contact,
  contactPermissionEvent,
  type Database,
  type MessageAttachment,
  type MessageProvider,
  message,
  messageAttachment,
  messageReaction,
  providerEventRaw,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import type { MessageEventPayload, ProviderEvent } from '@knoqra/providers';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { FOREIGN_CONNECTION, mayApplyTo } from '../events/connector-guard';
import type { EventHandler, HandlerResult } from '../events/registry';
import type { ReceivedMessageEvent } from '../extensions';
import { findContact } from '../lib/contact-access';
import { logger } from '../lib/logger';
import { latestPermissionEvents } from '../lib/permissions';
import { publish } from '../lib/realtime';
import { downloadInbound, recordDownload } from './attachments';
import { resolveRoute } from './routing';
import { loadMessageJson, publishMessage } from './send';
import { telnyxMessagingClient } from './senders';
import { applyReceipt, ensureConversation, insertMessage } from './store';

/** A receipt arrived before its message was recorded; the consumer retries it later. */
export class MessageNotYetKnownError extends Error {
  constructor(readonly rawEventId: string) {
    super('message not yet known');
    this.name = 'MessageNotYetKnownError';
  }
}

const MAX_MERGE_HOPS = 5;
const MAX_KEYWORD_EVIDENCE = 40;
const CHANNEL_LABELS: Record<MessagingChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

const RECEIPT_STATUS: Partial<Record<ProviderEvent['type'], MessageStatus>> = {
  'message.sent': 'sent',
  'message.delivered': 'delivered',
  'message.read': 'read',
  'message.failed': 'failed',
};

/** Nothing to run after commit. */
const PROCESSED: HandlerResult = { status: 'processed', after: async () => undefined };

/**
 * What an applied event changed, for the after-commit step: messages to publish, files to fetch,
 * and the new inbound messages the editions hear about.
 */
interface Changes {
  messageIds: Set<string>;
  conversationIds: Set<string>;
  downloads: { attachment: MessageAttachment; businessNumber: string }[];
  received: Omit<ReceivedMessageEvent, 'orgId'>[];
}

/**
 * After commit: download new inbound files into storage, then publish every changed message and
 * conversation to the organization's realtime sockets. Best effort; failures are logged.
 */
function afterCommit(
  db: Database,
  env: Env,
  orgId: string,
  changes: Changes,
  fetchImpl?: typeof fetch,
): () => Promise<void> {
  return async () => {
    if (changes.downloads.length > 0) {
      const client = await withTenant(db, orgId, (tx) => telnyxMessagingClient(tx, env, fetchImpl));
      for (const { attachment, businessNumber } of changes.downloads) {
        const outcome = await downloadInbound(env, attachment, businessNumber, client);
        if (outcome.status !== 'pending') {
          await withTenant(db, orgId, (tx) => recordDownload(tx, attachment, outcome));
        }
      }
    }
    for (const id of changes.messageIds) {
      const json = await withTenant(db, orgId, (tx) => loadMessageJson(tx, env, id));
      if (json) await publishMessage(env, orgId, json);
    }
    for (const conversationId of changes.conversationIds) {
      await publish(env, orgId, { type: 'conversation.updated', data: { conversationId } });
    }
    for (const received of changes.received) {
      await runAfterMessageReceived(env, { orgId, ...received });
    }
  };
}

/** The editions' `afterMessageReceived` hooks, one after another; an error is logged, never thrown. */
async function runAfterMessageReceived(env: Env, event: ReceivedMessageEvent): Promise<void> {
  for (const extension of env.EXTENSIONS ?? []) {
    if (!extension.afterMessageReceived) continue;
    try {
      await extension.afterMessageReceived(env, event);
    } catch (error) {
      logger.error('messaging.after_received_failed', {
        extension: extension.name,
        messageId: event.messageId,
        error,
      });
    }
  }
}

/**
 * The `message` handler of the event registry: normalizes one inbound message or receipt into
 * conversations, messages, receipts and consent. An address with no route is ignored (nothing to
 * apply, ids only in the log). Logs carry ids only, never bodies or phone numbers.
 */
export const handleMessageEvent: EventHandler<'message'> = async (ctx, normalized) => {
  const { db, rawEventId } = ctx;
  const { event, payload } = normalized;
  const received = event.type === 'message.received';
  const address = received ? payload.to : payload.from;
  const route = await resolveRoute(db, event.provider, payload.channel, address);
  if (!route) {
    logger.warn('messaging.unroutable', { rawEventId, provider: event.provider });
    return { status: 'ignored', reason: 'unroutable' };
  }
  if (!mayApplyTo(ctx, route.orgId)) {
    logger.warn('messaging.foreign_connection', { rawEventId, provider: event.provider });
    return FOREIGN_CONNECTION;
  }

  return withTenant(db, route.orgId, async (tx) => {
    // First statement: the row lock serializes concurrent consumers of the same raw id; the loser
    // sees zero rows. A thrown error rolls the claim back so the retry starts clean.
    const claimed = await tx
      .update(providerEventRaw)
      .set({ status: 'processed', processedAt: sql`now()`, parkReason: null })
      .where(and(eq(providerEventRaw.id, rawEventId), isNull(providerEventRaw.processedAt)))
      .returning({ id: providerEventRaw.id });
    if (claimed.length === 0) return PROCESSED;

    const changes: Changes = {
      messageIds: new Set(),
      conversationIds: new Set(),
      downloads: [],
      received: [],
    };
    const ctxIn: EventContext = { tx, orgId: route.orgId, rawEventId, event, payload, changes };
    if (received) await ingestInbound(ctxIn);
    else await ingestReceipt(ctxIn);
    return {
      status: 'processed',
      after: afterCommit(db, ctx.env, route.orgId, changes, ctx.fetch),
    } satisfies HandlerResult;
  });
};

interface EventContext {
  tx: Tx;
  orgId: string;
  rawEventId: string;
  event: ProviderEvent;
  payload: MessageEventPayload;
  changes: Changes;
}

/**
 * A message of the conversation by the id a provider gave for it: the channel's own id (wamid), or
 * the provider's message id (Telnyx may rewrite references to its own ids).
 */
async function messageByReference(tx: Tx, conversationId: string, ref: string) {
  const [row] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        or(eq(message.channelMessageId, ref), eq(message.providerMessageId, ref)),
      ),
    )
    .limit(1);
  return row;
}

/** The contact's reaction lands on its target message; an unknown target is ignored. */
async function applyInboundReaction(
  ctx: EventContext,
  conversationId: string,
  reaction: NonNullable<MessageEventPayload['reaction']>,
): Promise<void> {
  const { tx, orgId, rawEventId } = ctx;
  const target = await messageByReference(tx, conversationId, reaction.targetId);
  if (!target) {
    logger.warn('messaging.reaction_target_unknown', { rawEventId, orgId });
    return;
  }
  if (reaction.emoji === null) {
    await tx
      .delete(messageReaction)
      .where(
        and(eq(messageReaction.messageId, target.id), eq(messageReaction.direction, 'inbound')),
      );
  } else {
    await tx
      .insert(messageReaction)
      .values({
        organizationId: orgId,
        messageId: target.id,
        direction: 'inbound',
        emoji: reaction.emoji,
        status: 'sent',
      })
      .onConflictDoUpdate({
        target: [messageReaction.messageId, messageReaction.direction],
        set: { emoji: reaction.emoji, status: 'sent' },
      });
  }
  ctx.changes.messageIds.add(target.id);
}

async function ingestInbound(ctx: EventContext): Promise<void> {
  const { tx, orgId, rawEventId, event, payload } = ctx;
  const phone = normalizePhone(payload.from);
  if (!phone.ok) {
    logger.warn('messaging.invalid_sender', { rawEventId, orgId });
    return;
  }
  const found = await inboundContact(tx, orgId, phone.value, payload.channel);
  const contactRow = await lockLiveContact(tx, found.id);
  const conv = await ensureConversation(tx, orgId, contactRow.id, payload.channel);

  if (payload.reaction) {
    await applyInboundReaction(ctx, conv.id, payload.reaction);
    return;
  }

  const [existing] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.provider, event.provider as MessageProvider),
        eq(message.providerMessageId, event.resourceId),
      ),
    )
    .limit(1);
  if (existing) return;

  const body = payload.body ?? '';
  const replyTo = payload.replyToId
    ? await messageByReference(tx, conv.id, payload.replyToId)
    : undefined;
  const inserted = await insertMessage(tx, {
    orgId,
    conversation: conv,
    direction: 'inbound',
    body,
    status: 'received',
    provider: event.provider,
    providerMessageId: event.resourceId,
    occurredAt: new Date(event.occurredAt),
    channelMessageId: payload.channelMessageId ?? null,
    replyToMessageId: replyTo?.id ?? null,
    attachmentKind: payload.media?.kind ?? null,
  });
  ctx.changes.messageIds.add(inserted.id);
  ctx.changes.conversationIds.add(conv.id);
  ctx.changes.received.push({
    conversationId: conv.id,
    messageId: inserted.id,
    contactId: conv.contactId,
    channel: payload.channel,
  });

  if (payload.media) {
    const [attachment] = await tx
      .insert(messageAttachment)
      .values({
        organizationId: orgId,
        conversationId: conv.id,
        messageId: inserted.id,
        direction: 'inbound',
        kind: payload.media.kind,
        mimeType: payload.media.mimeType,
        fileName: payload.media.fileName ?? null,
        status: 'pending',
        providerMediaId: payload.media.mediaId ?? null,
        sourceUrl: payload.media.url ?? null,
        sha256: payload.media.sha256 ?? null,
      })
      .returning();
    if (attachment) ctx.changes.downloads.push({ attachment, businessNumber: payload.to });
  }

  // Keywords count only in text the contact typed, never in a file's caption.
  const keyword = payload.media ? null : classifyKeyword(body);
  if (keyword) await applyKeyword(tx, orgId, conv.contactId, payload.channel, keyword, body);
}

/**
 * The contact for an inbound number, created on first contact, following merges. Works under both
 * a full UNIQUE(organization_id, phone_e164) and a partial unique index over unmerged contacts
 * only: lookups never rely on a conflict target, and the insert uses an untargeted
 * ON CONFLICT DO NOTHING, which any unique constraint or partial unique index satisfies.
 */
async function inboundContact(
  tx: Tx,
  orgId: string,
  e164: string,
  channel: MessagingChannel,
): Promise<Contact> {
  const existing = await contactForPhone(tx, orgId, e164);
  if (existing) return existing;
  await tx
    .insert(contact)
    .values({
      organizationId: orgId,
      displayName: e164,
      phoneE164: e164,
      source: 'inbound',
      sourceDetail: `Inbound ${CHANNEL_LABELS[channel]}`,
    })
    .onConflictDoNothing();
  // A concurrent inbound may have won the insert; either way the row is now committed or ours.
  const created = await contactForPhone(tx, orgId, e164);
  if (!created) throw new Error('inbound contact not found after insert');
  return created;
}

/**
 * The live contact holding a number: an unmerged holder first; otherwise a merged holder followed
 * along `mergedIntoId` to its target (plan ruling 7). Undefined when no contact holds the number.
 */
async function contactForPhone(tx: Tx, orgId: string, e164: string): Promise<Contact | undefined> {
  const byPhone = (merged: boolean) =>
    tx
      .select()
      .from(contact)
      .where(
        and(
          eq(contact.organizationId, orgId),
          eq(contact.phoneE164, e164),
          merged ? isNotNull(contact.mergedIntoId) : isNull(contact.mergedIntoId),
        ),
      )
      .orderBy(asc(contact.createdAt), asc(contact.id))
      .limit(1);
  const [live] = await byPhone(false);
  if (live) return live;
  const [merged] = await byPhone(true);
  if (!merged) return undefined;
  let row: Contact | undefined = merged;
  for (let hop = 0; row?.mergedIntoId && hop < MAX_MERGE_HOPS; hop++) {
    row = await findContact(tx, row.mergedIntoId, false);
  }
  if (!row) throw new Error('merge target of inbound contact not found');
  return row;
}

/**
 * Locks the inbound contact FOR UPDATE before its thread is touched, so a merge in flight (which
 * locks contacts, then conversations) finishes first, and contact → conversation is the one lock
 * order. A contact merged while we waited is followed to its target, which is locked in turn.
 * FOR UPDATE, not FOR SHARE: the keyword step re-locks FOR UPDATE, and a share-to-update upgrade
 * can deadlock.
 */
async function lockLiveContact(tx: Tx, contactId: string): Promise<Contact> {
  let row = await findContact(tx, contactId, true);
  for (let hop = 0; row?.mergedIntoId && hop < MAX_MERGE_HOPS; hop++) {
    row = await findContact(tx, row.mergedIntoId, true);
  }
  // Past MAX_MERGE_HOPS the last row is used, as contactForPhone does.
  if (!row) throw new Error('inbound contact vanished while locking');
  return row;
}

async function applyKeyword(
  tx: Tx,
  orgId: string,
  contactId: string,
  channel: MessagingChannel,
  keyword: 'stop' | 'start',
  body: string,
): Promise<void> {
  // Consent writers hold the contact row lock and timestamp with clock_timestamp().
  await findContact(tx, contactId, true);
  const label = CHANNEL_LABELS[channel];
  const consentTimeline = (title: string, refId: string | null) =>
    tx.insert(timelineEvent).values({
      organizationId: orgId,
      contactId,
      kind: 'consent',
      title,
      source: 'provider',
      refType: refId ? 'contact_permission_event' : null,
      refId,
      occurredAt: sql`clock_timestamp()`,
    });

  // Do not contact is sticky: neither keyword may replace it (a STOP would record opted_out, which
  // a later START could then grant). Record the reply on the timeline only.
  const current = currentPermissions(await latestPermissionEvents(tx, contactId))[channel];
  if (current === 'do_not_contact') {
    const word = keyword === 'stop' ? 'STOP' : 'START';
    await consentTimeline(`${word} received · contact stays Do not contact`, null);
    return;
  }
  const [event] = await tx
    .insert(contactPermissionEvent)
    .values({
      organizationId: orgId,
      contactId,
      channel,
      status: keyword === 'stop' ? 'opted_out' : 'granted',
      source: keyword === 'stop' ? 'inbound_stop' : 'inbound_start',
      evidence: `Replied "${body.trim().slice(0, MAX_KEYWORD_EVIDENCE)}"`,
      actorUserId: null,
      createdAt: sql`clock_timestamp()` as unknown as Date,
    })
    .returning({ id: contactPermissionEvent.id });
  if (!event) throw new Error('permission insert returned no row');
  await consentTimeline(
    keyword === 'stop' ? `${label} opted out by reply STOP` : `${label} opted in by reply START`,
    event.id,
  );
}

async function ingestReceipt(ctx: EventContext): Promise<void> {
  const { tx, orgId, rawEventId, event, payload } = ctx;
  const incoming = RECEIPT_STATUS[event.type];
  if (!incoming) {
    logger.warn('messaging.invalid_event', { rawEventId, provider: event.provider });
    return;
  }
  const result = await applyReceipt(tx, {
    orgId,
    providerMessageId: event.resourceId,
    provider: event.provider,
    incoming,
    occurredAt: new Date(event.occurredAt),
    rawEventId,
    error: payload.error,
    ...(payload.final === true ? { final: true } : {}),
  });
  if (result === 'unknown_message') throw new MessageNotYetKnownError(rawEventId);
  if (result === 'applied') {
    const [row] = await tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.provider, event.provider as MessageProvider),
          eq(message.providerMessageId, event.resourceId),
        ),
      )
      .limit(1);
    if (row) ctx.changes.messageIds.add(row.id);
  }
}

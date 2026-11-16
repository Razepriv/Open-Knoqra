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
  type MessageProvider,
  message,
  providerEventRaw,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import type { MessageEventPayload, ProviderEvent } from '@knoqra/providers';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { FOREIGN_CONNECTION, mayApplyTo } from '../events/connector-guard';
import type { EventHandler, HandlerResult } from '../events/registry';
import { findContact } from '../lib/contact-access';
import { logger } from '../lib/logger';
import { latestPermissionEvents } from '../lib/permissions';
import { resolveRoute } from './routing';
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

/** Nothing to run after commit: messaging has no realtime fan-out yet (the Inbox polls). */
const PROCESSED: HandlerResult = { status: 'processed', after: async () => undefined };

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

    const ctxIn: EventContext = { tx, orgId: route.orgId, rawEventId, event, payload };
    if (received) await ingestInbound(ctxIn);
    else await ingestReceipt(ctxIn);
    return PROCESSED;
  });
};

interface EventContext {
  tx: Tx;
  orgId: string;
  rawEventId: string;
  event: ProviderEvent;
  payload: MessageEventPayload;
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
  await insertMessage(tx, {
    orgId,
    conversation: conv,
    direction: 'inbound',
    body,
    status: 'received',
    provider: event.provider,
    providerMessageId: event.resourceId,
    occurredAt: new Date(event.occurredAt),
  });

  const keyword = classifyKeyword(body);
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
}

import {
  type ComposerReason,
  type ComposerState,
  type MessagingChannel,
  newId,
  renderTemplate,
  templatePlaceholders,
} from '@knoqra/core';
import {
  contact,
  conversation,
  type Database,
  message,
  messageTemplate,
  type Tx,
  withTenant,
} from '@knoqra/db';
import {
  type MessagingProvider,
  TelnyxMessagingError,
  type WhatsAppTemplateRef,
} from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { isUniqueViolation } from '../lib/contact-fields';
import type { Tenant } from '../lib/context';
import type { ErrorCode } from '../lib/envelope';
import { logger } from '../lib/logger';
import { retryOnConflict } from '../lib/retry';
import { insertMessagingAudit } from './audit';
import { composerFor } from './composer';
import { ledgerMessageCost, type MessageCostHook, type MessageCostRefusal } from './cost';
import { type MessageJson, messageJson } from './json';
import { hasTelnyxCredential, messagingProviderFor, type Sender, senderFor } from './senders';
import {
  type ConversationRow,
  insertMessage,
  type ProviderSendResult,
  recordProviderResult,
} from './store';

export const CONVERSATION_ID_PATTERN = /^cv_[0-9a-f]{32}$/;
const TEMPLATE_ID_PATTERN = /^mt_[0-9a-f]{32}$/;
const CLIENT_MESSAGE_ID_UNIQUE = 'message_organization_id_client_message_id_unique';

export interface SendDeps {
  db: Database;
  env: Env;
  tenant: Tenant;
  /** Defaults to the ledger: reserve the channel's rate on M2's wallet. Tests inject stubs. */
  cost?: MessageCostHook;
  /** Defaults to `messagingProviderFor(tx, sender, env)`; tests inject stubs. Null means none. */
  provider?: MessagingProvider | null;
  /** The fetch the Telnyx provider uses; tests inject fixtures (no network in tests). */
  fetch?: typeof fetch;
}

/** Exactly one of `body` and `templateId` (the route answers 400 otherwise; here it throws). */
export interface SendInput {
  clientMessageId: string;
  body?: string;
  templateId?: string;
}

export type SendError = {
  kind: 'error';
  status: 402 | 404 | 422;
  code: ErrorCode;
  message: string;
};
export type SendResult = { kind: 'created' | 'replayed'; message: MessageJson } | SendError;

const BLOCKED_COPY: Partial<Record<ComposerReason, string>> = {
  consent_required: 'no consent is on file for this channel.',
  revoked: 'consent was withdrawn.',
  opted_out: 'they opted out.',
  do_not_contact: 'they are marked do not contact.',
};
const PAUSED_COPY: Partial<Record<ComposerReason, string>> = {
  no_sender: 'this channel has no sender yet.',
  registration_pending: 'sender registration is still pending.',
  registration_rejected: 'sender registration was rejected.',
  live_disabled: 'live sending is not switched on here.',
};
/** M2's call copy, for a message. */
const SPEND_COPY: Record<MessageCostRefusal, string> = {
  insufficient_funds: 'Not enough credit for this message.',
  stop_cap: 'This message would pass the monthly spend cap.',
};

interface Refusal {
  kind: 'refused';
  outcome: 'denied' | 'not_found';
  reason: string;
  error: SendError;
  metadata?: Record<string, unknown>;
}

interface Ready {
  kind: 'ready';
  messageId: string;
  provider: MessagingProvider;
  channel: MessagingChannel;
  from: string;
  to: string;
  body: string;
  templateId: string | null;
  /** The Meta template for a WhatsApp template send through Telnyx. */
  whatsappTemplate: WhatsAppTemplateRef | null;
}

type Prepared = Ready | Refusal | { kind: 'replayed'; message: MessageJson };

const refuse = (
  outcome: Refusal['outcome'],
  reason: string,
  status: SendError['status'],
  code: ErrorCode,
  text: string,
  metadata?: Record<string, unknown>,
): Refusal => ({
  kind: 'refused',
  outcome,
  reason,
  error: { kind: 'error', status, code, message: text },
  ...(metadata ? { metadata } : {}),
});

const conversationNotFound = (reason: string) =>
  refuse('not_found', reason, 404, 'not_found', 'Conversation not found.');

/** Composer gating; null when a send of this kind may proceed. */
function gate(state: ComposerState, wantsTemplate: boolean): Refusal | null {
  if (state.mode === 'blocked') {
    const copy = BLOCKED_COPY[state.reason] ?? 'sending is not allowed.';
    return refuse(
      'denied',
      state.reason,
      422,
      'send_blocked',
      `Messages to this contact are blocked: ${copy}`,
    );
  }
  if (state.mode === 'paused') {
    const copy = PAUSED_COPY[state.reason] ?? 'sending is not available.';
    return refuse('denied', state.reason, 422, 'send_paused', `Sending is paused: ${copy}`);
  }
  if (state.mode === 'template_only' && !wantsTemplate) {
    return refuse(
      'denied',
      state.reason,
      422,
      'template_required',
      'The 24-hour WhatsApp window is closed. Send an approved template instead.',
    );
  }
  return null;
}

const templateRefusal = (reason: string, text: string, metadata?: Record<string, unknown>) =>
  refuse('denied', reason, 422, 'validation_error', text, metadata);

export const META_FIELDS_REQUIRED =
  'Live WhatsApp templates need the Meta template name and language.';

interface ResolvedTemplate {
  body: string;
  whatsappTemplate: WhatsAppTemplateRef | null;
}

/**
 * Meta's body parameters: the rendered value of each placeholder, once each, in order of first
 * appearance. The Meta template must declare its variables in that same order.
 */
function templateParameters(
  body: string,
  recipient: { displayName: string; company: string | null },
): string[] {
  const names = templatePlaceholders(body);
  if (!names.ok) throw new Error('rendered template has unknown placeholders');
  return names.value.map((name) => {
    const value = renderTemplate(`{{${name}}}`, recipient);
    if (!value.ok) throw new Error('rendered template has a missing value');
    return value.value;
  });
}

/**
 * The contact's fields for template placeholders. A contact created by an inbound message is named
 * after its own number, which is not a name: `{{first_name}}` and `{{name}}` count as missing then,
 * rather than greeting "Hi +1202...".
 */
function templateFields(recipient: { phone: string; displayName: string; company: string | null }) {
  const named = recipient.displayName.trim() !== recipient.phone;
  return { displayName: named ? recipient.displayName : '', company: recipient.company };
}

/** The template's rendered body, or why it cannot be sent on this conversation. */
async function resolveTemplate(
  tx: Tx,
  templateId: string,
  channel: MessagingChannel,
  recipient: { displayName: string; company: string | null },
  viaTelnyx: boolean,
): Promise<ResolvedTemplate | Refusal> {
  const notFound = refuse(
    'not_found',
    'template_not_found',
    404,
    'not_found',
    'Template not found.',
    {
      templateId: TEMPLATE_ID_PATTERN.test(templateId) ? templateId : null,
    },
  );
  if (!TEMPLATE_ID_PATTERN.test(templateId)) return notFound;
  const [tpl] = await tx
    .select()
    .from(messageTemplate)
    .where(eq(messageTemplate.id, templateId))
    .limit(1);
  if (!tpl) return notFound;
  const meta = { templateId };
  if (tpl.archivedAt) {
    return templateRefusal('template_archived', 'This template is archived.', meta);
  }
  if (tpl.channel !== channel) {
    return templateRefusal(
      'template_channel_mismatch',
      'This template is for another channel.',
      meta,
    );
  }
  // SMS templates need no outside approval; WhatsApp templates must be approved by Meta.
  if (channel === 'whatsapp' && tpl.approvalStatus !== 'approved') {
    return templateRefusal('template_not_approved', 'This template is not approved yet.', meta);
  }
  // Telnyx sends a WhatsApp template by its Meta name and language, never as free text.
  const live = channel === 'whatsapp' && viaTelnyx;
  if (live && (!tpl.whatsappTemplateName || !tpl.whatsappLanguage)) {
    return templateRefusal('template_meta_missing', META_FIELDS_REQUIRED, meta);
  }
  const rendered = renderTemplate(tpl.body, recipient);
  if (!rendered.ok) {
    const names = rendered.error.missing.map((n) => `{{${n}}}`).join(' and ');
    return templateRefusal(
      'template_missing_values',
      `This template needs ${names}, which this contact doesn't have.`,
      { ...meta, missing: rendered.error.missing },
    );
  }
  const whatsappTemplate =
    live && tpl.whatsappTemplateName && tpl.whatsappLanguage
      ? {
          name: tpl.whatsappTemplateName,
          language: tpl.whatsappLanguage,
          parameters: templateParameters(tpl.body, recipient),
        }
      : null;
  return { body: rendered.value, whatsappTemplate };
}

async function lockConversation(tx: Tx, id: string): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversation)
    .where(eq(conversation.id, id))
    .limit(1)
    .for('update');
  return row;
}

/** The message (with its template's name) as JSON, inside the caller's tenant transaction. */
export async function loadMessageJson(tx: Tx, id: string): Promise<MessageJson | undefined> {
  const [row] = await tx
    .select({ message, templateName: messageTemplate.name })
    .from(message)
    .leftJoin(
      messageTemplate,
      and(
        eq(messageTemplate.id, message.templateId),
        eq(messageTemplate.organizationId, message.organizationId),
      ),
    )
    .where(eq(message.id, id))
    .limit(1);
  return row ? messageJson(row.message, row.templateName) : undefined;
}

async function existingByClientId(tx: Tx, clientMessageId: string) {
  const [row] = await tx
    .select({ id: message.id })
    .from(message)
    .where(eq(message.clientMessageId, clientMessageId))
    .limit(1);
  return row ? loadMessageJson(tx, row.id) : undefined;
}

interface Gated {
  conv: ConversationRow;
  sender: Sender;
  provider: MessagingProvider;
  to: string;
  body: string;
  templateId: string | null;
  whatsappTemplate: WhatsAppTemplateRef | null;
}

/** Composer, provider and template checks for a locked conversation. */
async function checkSend(
  tx: Tx,
  deps: SendDeps,
  conv: ConversationRow,
  input: SendInput,
): Promise<Gated | Refusal> {
  const wantsTemplate = input.templateId !== undefined;
  const credential = await hasTelnyxCredential(tx);
  const composers = await composerFor(tx, deps.env, [conv], new Date(), credential);
  const state = composers.get(conv.id);
  if (!state) throw new Error('composer state missing');
  const gated = gate(state, wantsTemplate);
  if (gated) return gated;

  const sender = await senderFor(tx, deps.env, conv.channel, credential);
  const provider =
    deps.provider !== undefined
      ? deps.provider
      : sender
        ? await messagingProviderFor(tx, sender, deps.env, deps.fetch)
        : null;
  if (!sender || !provider) {
    return refuse(
      'denied',
      'live_disabled',
      422,
      'send_paused',
      `Sending is paused: ${PAUSED_COPY.live_disabled}`,
    );
  }

  const [recipient] = await tx
    .select({
      phone: contact.phoneE164,
      displayName: contact.displayName,
      company: contact.company,
    })
    .from(contact)
    .where(eq(contact.id, conv.contactId))
    .limit(1);
  if (!recipient) return conversationNotFound('contact_missing');

  if (input.templateId !== undefined) {
    const tpl = await resolveTemplate(
      tx,
      input.templateId,
      conv.channel,
      templateFields(recipient),
      sender.provider === 'telnyx',
    );
    if ('kind' in tpl) return tpl;
    return {
      conv,
      sender,
      provider,
      to: recipient.phone,
      body: tpl.body,
      templateId: input.templateId,
      whatsappTemplate: tpl.whatsappTemplate,
    };
  }
  return {
    conv,
    sender,
    provider,
    to: recipient.phone,
    body: input.body as string,
    templateId: null,
    whatsappTemplate: null,
  };
}

/**
 * Step 1 of a send, in one tenant transaction: lock the conversation, answer a replay, recompute
 * the composer, reserve the message's cost, insert the queued message and audit it. A refusal
 * returns before anything else is written (its audit, and an opened wallet, commit alone).
 */
async function prepare(
  tx: Tx,
  deps: SendDeps,
  conversationId: string,
  input: SendInput,
): Promise<Prepared> {
  const { tenant } = deps;
  const conv = await lockConversation(tx, conversationId);
  if (!conv) return conversationNotFound('conversation_not_found');

  // After the lock: a concurrent send of the same clientMessageId has committed by now.
  const replay = await existingByClientId(tx, input.clientMessageId);
  if (replay) return { kind: 'replayed', message: replay };

  const checked = await checkSend(tx, deps, conv, input);
  if ('kind' in checked) return checked;

  const messageId = newId('mg');
  const cost = await (deps.cost ?? ledgerMessageCost(deps.env)).beforeSend(tx, {
    orgId: tenant.orgId,
    actorUserId: tenant.userId,
    channel: conv.channel,
    messageId,
    provider: checked.sender.provider,
  });
  if (!cost.ok) {
    return refuse('denied', cost.reason, 402, 'spend_blocked', SPEND_COPY[cost.reason]);
  }

  await insertMessage(tx, {
    id: messageId,
    orgId: tenant.orgId,
    conversation: conv,
    direction: 'outbound',
    body: checked.body,
    status: 'queued',
    provider: checked.sender.provider,
    clientMessageId: input.clientMessageId,
    templateId: checked.templateId,
    authorUserId: tenant.userId,
    occurredAt: new Date(),
  });
  // Never the body or the phone number: they are PII.
  await insertMessagingAudit(tx, tenant, {
    action: 'message.send',
    entityType: 'message',
    outcome: 'allowed',
    entityId: messageId,
    metadata: {
      conversationId: conv.id,
      channel: conv.channel,
      templateId: checked.templateId,
      provider: checked.sender.provider,
    },
  });
  return {
    kind: 'ready',
    messageId,
    provider: checked.provider,
    channel: conv.channel,
    from: checked.sender.address,
    to: checked.to,
    body: checked.body,
    templateId: checked.templateId,
    whatsappTemplate: checked.whatsappTemplate,
  };
}

/** Step 2, outside any transaction: hand the message to the provider. Never throws. */
async function dispatch(orgId: string, ready: Ready): Promise<ProviderSendResult> {
  const base = { orgId, from: ready.from, to: ready.to, idempotencyKey: ready.messageId };
  try {
    const accepted =
      ready.channel === 'sms'
        ? await ready.provider.sendSms({ ...base, body: ready.body })
        : await ready.provider.sendWhatsApp({
            ...base,
            body: ready.body,
            ...(ready.templateId ? { templateId: ready.templateId } : {}),
            ...(ready.whatsappTemplate ? { template: ready.whatsappTemplate } : {}),
          });
    return { ok: true, providerMessageId: accepted.providerMessageId };
  } catch (error) {
    const failure = error instanceof TelnyxMessagingError ? error.failure : undefined;
    // Ids and codes only: the provider error may echo the body or the number.
    logger.warn('messaging.provider_send_failed', {
      messageId: ready.messageId,
      channel: ready.channel,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(failure ? { failureCode: failure.code } : {}),
    });
    return failure ? { ok: false, failure } : { ok: false };
  }
}

function insertRefusalAudit(tx: Tx, tenant: Tenant, entityId: string | null, refusal: Refusal) {
  return insertMessagingAudit(tx, tenant, {
    action: 'message.send',
    entityType: 'conversation',
    outcome: refusal.outcome,
    entityId,
    metadata: { reason: refusal.reason, ...refusal.metadata },
  });
}

/**
 * Sends a free-text or template message on a conversation. Idempotent per organization on
 * `clientMessageId`: a repeat (even a concurrent one) answers the existing message and never
 * calls the provider again. The provider call happens outside every database transaction.
 */
export async function sendMessage(
  deps: SendDeps,
  conversationId: string,
  input: SendInput,
): Promise<SendResult> {
  const { db, tenant } = deps;
  if ((input.body === undefined) === (input.templateId === undefined)) {
    throw new TypeError('sendMessage needs exactly one of body and templateId');
  }
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    const refusal = conversationNotFound('malformed_id');
    await withTenant(db, tenant.orgId, (tx) => insertRefusalAudit(tx, tenant, null, refusal));
    return refusal.error;
  }

  let prepared: Prepared;
  try {
    // A send locks the conversation, then the contact; a contact merge locks them the other way
    // round. Postgres aborts the loser of that deadlock, and this whole transaction (the ledger
    // hold included) rolled back, so it is safe to run once more.
    prepared = await retryOnConflict(() =>
      withTenant(db, tenant.orgId, async (tx) => {
        const step = await prepare(tx, deps, conversationId, input);
        // A refusal wrote nothing else, so its audit commits alone in this transaction.
        if (step.kind === 'refused') await insertRefusalAudit(tx, tenant, conversationId, step);
        return step;
      }),
    );
  } catch (error) {
    // Lost the insert race to a send of the same clientMessageId on another conversation.
    if (!isUniqueViolation(error, CLIENT_MESSAGE_ID_UNIQUE)) throw error;
    const existing = await withTenant(db, tenant.orgId, (tx) =>
      existingByClientId(tx, input.clientMessageId),
    );
    if (!existing) throw error;
    return { kind: 'replayed', message: existing };
  }

  if (prepared.kind === 'replayed') return prepared;
  if (prepared.kind === 'refused') return prepared.error;

  const result = await dispatch(tenant.orgId, prepared);
  // The provider has answered, so this transaction must land: a lost deadlock or serialization
  // failure would otherwise leave the message queued with its hold reserved for good (an opted_out
  // result locks the contact first, then the message, as the other consent writers do). Recording
  // a result is idempotent, so a retry posts nothing twice.
  const sent = await retryOnConflict(() =>
    withTenant(db, tenant.orgId, async (tx) => {
      await recordProviderResult(tx, prepared.messageId, result);
      return loadMessageJson(tx, prepared.messageId);
    }),
  );
  if (!sent) throw new Error('sent message vanished');
  return { kind: 'created', message: sent };
}

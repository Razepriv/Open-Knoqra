import { z } from '@hono/zod-openapi';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_STATUSES,
  type ComposerState,
  MESSAGE_STATUSES,
  MESSAGING_CHANNELS,
  REGISTRATION_STATUSES,
} from '@knoqra/core';
import type { MessageRow } from './store';

export const ComposerSchema = z
  .object({
    mode: z.enum(['free', 'template_only', 'paused', 'blocked']),
    reason: z.enum([
      'ok',
      'consent_required',
      'revoked',
      'opted_out',
      'do_not_contact',
      'no_sender',
      'registration_pending',
      'registration_rejected',
      'live_disabled',
      'window_closed',
    ]),
    windowExpiresAt: z.iso.datetime().nullable(),
  })
  .openapi('Composer');

export const ConversationSchema = z
  .object({
    id: z.string(),
    channel: z.enum(MESSAGING_CHANNELS),
    contact: z.object({
      id: z.string(),
      displayName: z.string(),
      phone: z.string(),
      company: z.string().nullable(),
    }),
    lastActivityAt: z.iso.datetime(),
    lastInboundAt: z.iso.datetime().nullable(),
    lastMessagePreview: z.string().nullable(),
    lastMessageDirection: z.enum(['inbound', 'outbound']).nullable(),
    lastMessageStatus: z.string().nullable(),
    unreadCount: z.number().int(),
    composer: ComposerSchema,
  })
  .openapi('Conversation');

export const SenderJsonSchema = z
  .object({
    id: z.string(),
    channel: z.enum(MESSAGING_CHANNELS),
    provider: z.enum(['fake', 'telnyx']),
    address: z.string(),
    registrationStatus: z.enum(REGISTRATION_STATUSES),
    sandbox: z.boolean(),
    liveEnabled: z.boolean(),
  })
  .openapi('ConversationSender');

export const ConversationDetailSchema = ConversationSchema.extend({
  sender: SenderJsonSchema.nullable(),
}).openapi('ConversationDetail');

export const AttachmentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(ATTACHMENT_KINDS),
    mimeType: z.string(),
    sizeBytes: z.number().int().nullable(),
    fileName: z.string().nullable(),
    status: z.enum(ATTACHMENT_STATUSES),
    durationMs: z.number().int().nullable(),
    /** Up to 48 bars from 0 to 100, for a voice note's waveform. */
    waveform: z.array(z.number().int()).nullable(),
    /** A signed link to the file, valid until `urlExpiresAt`; null when it cannot be fetched. */
    url: z.string().nullable(),
    urlExpiresAt: z.iso.datetime().nullable(),
  })
  .openapi('MessageAttachment');
export type AttachmentJson = z.infer<typeof AttachmentSchema>;

export const ReactionSchema = z
  .object({
    emoji: z.string(),
    /** `inbound` is the contact's reaction, `outbound` the workspace's. */
    direction: z.enum(['inbound', 'outbound']),
    status: z.enum(['pending', 'sent', 'failed']),
  })
  .openapi('MessageReaction');
export type ReactionJson = z.infer<typeof ReactionSchema>;

export const ReplyPreviewSchema = z
  .object({
    id: z.string(),
    direction: z.enum(['inbound', 'outbound']),
    body: z.string(),
    attachmentKind: z.enum(ATTACHMENT_KINDS).nullable(),
  })
  .openapi('MessageReplyPreview');
export type ReplyPreviewJson = z.infer<typeof ReplyPreviewSchema>;

export const MessageSchema = z
  .object({
    id: z.string(),
    conversationId: z.string(),
    channel: z.enum(MESSAGING_CHANNELS),
    direction: z.enum(['inbound', 'outbound']),
    body: z.string(),
    templateId: z.string().nullable(),
    templateName: z.string().nullable(),
    status: z.enum(MESSAGE_STATUSES),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    authorUserId: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    /** The id the sender chose for an outbound send, so the Desk can match its optimistic copy. */
    clientMessageId: z.string().nullable(),
    occurredAt: z.iso.datetime(),
    statusUpdatedAt: z.iso.datetime(),
    attachments: z.array(AttachmentSchema),
    reactions: z.array(ReactionSchema),
    replyTo: ReplyPreviewSchema.nullable(),
    /** Whether replies and reactions can target this message (inbound WhatsApp with its id). */
    replyable: z.boolean(),
  })
  .openapi('Message');
export type MessageJson = z.infer<typeof MessageSchema>;

/** What a message JSON adds to its row: files, reactions and the quoted message. */
export interface MessageExtras {
  attachments: AttachmentJson[];
  reactions: ReactionJson[];
  replyTo: ReplyPreviewJson | null;
}

export const NO_EXTRAS: MessageExtras = { attachments: [], reactions: [], replyTo: null };

export const MessageStatusEntrySchema = z
  .object({
    status: z.enum(MESSAGE_STATUSES),
    applied: z.boolean(),
    occurredAt: z.iso.datetime(),
    errorCode: z.string().nullable(),
  })
  .openapi('MessageStatusEntry');

export const MessageDetailSchema = MessageSchema.extend({
  statusHistory: z.array(MessageStatusEntrySchema),
}).openapi('MessageDetail');
export type MessageDetailJson = z.infer<typeof MessageDetailSchema>;

/** Inbound WhatsApp messages with a channel id can be replied to and reacted to. */
export const isReplyable = (row: {
  channel: string;
  direction: string;
  channelMessageId: string | null;
}): boolean =>
  row.channel === 'whatsapp' && row.direction === 'inbound' && row.channelMessageId !== null;

/** A message row (plus its template's name, if any) as the API's `Message`. */
export const messageJson = (
  row: MessageRow,
  templateName: string | null,
  extras: MessageExtras = NO_EXTRAS,
): MessageJson => ({
  id: row.id,
  conversationId: row.conversationId,
  channel: row.channel,
  direction: row.direction,
  body: row.body,
  templateId: row.templateId,
  templateName,
  status: row.status,
  error: row.errorCode ? { code: row.errorCode, message: row.errorMessage ?? '' } : null,
  authorUserId: row.authorUserId,
  providerMessageId: row.providerMessageId,
  clientMessageId: row.clientMessageId,
  occurredAt: row.occurredAt.toISOString(),
  statusUpdatedAt: row.statusUpdatedAt.toISOString(),
  ...extras,
  replyable: isReplyable(row),
});

export const ThreadNoteSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    authorUserId: z.string().nullable(),
    authorName: z.string().nullable(),
    occurredAt: z.iso.datetime(),
  })
  .openapi('ThreadNote');

export const ThreadItemSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('message'), message: MessageSchema }),
    z.object({ kind: z.literal('note'), note: ThreadNoteSchema }),
  ])
  .openapi('ThreadItem');
export type ThreadItemJson = z.infer<typeof ThreadItemSchema>;

export const composerJson = (state: ComposerState): z.infer<typeof ComposerSchema> => ({
  mode: state.mode,
  reason: state.reason,
  windowExpiresAt: state.windowExpiresAt ? state.windowExpiresAt.toISOString() : null,
});

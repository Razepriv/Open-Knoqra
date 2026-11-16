import {
  ATTACHMENT_KINDS,
  ATTACHMENT_STATUSES,
  MESSAGE_STATUSES,
  MESSAGING_CHANNELS,
  newId,
  REGISTRATION_STATUSES,
} from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { contact } from './contact';

export const MESSAGE_PROVIDERS = ['fake', 'telnyx'] as const;
export type MessageProvider = (typeof MESSAGE_PROVIDERS)[number];
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

const orgId = () =>
  text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Tenant-owned (all tables below): ENABLE + FORCE row-level security (sql/rls.sql). */
export const channelConnection = pgTable(
  'channel_connection',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('cc')),
    organizationId: orgId(),
    channel: text('channel', { enum: MESSAGING_CHANNELS }).notNull(),
    provider: text('provider', { enum: MESSAGE_PROVIDERS }).notNull(),
    address: text('address').notNull(),
    registrationStatus: text('registration_status', { enum: REGISTRATION_STATUSES })
      .notNull()
      .default('not_started'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('channel_connection_organization_id_channel_unique').on(
      table.organizationId,
      table.channel,
    ),
    unique('channel_connection_organization_id_id_unique').on(table.organizationId, table.id),
    check(
      'channel_connection_channel_check',
      sql`${table.channel} in (${inList(MESSAGING_CHANNELS)})`,
    ),
    check(
      'channel_connection_provider_check',
      sql`${table.provider} in (${inList(MESSAGE_PROVIDERS)})`,
    ),
    check(
      'channel_connection_registration_status_check',
      sql`${table.registrationStatus} in (${inList(REGISTRATION_STATUSES)})`,
    ),
    check('channel_connection_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/**
 * Maps a provider address to its tenant so the inbound consumer can resolve a tenant before it
 * has one (SELECT is open via the route_lookup policy; writes stay tenant-checked).
 */
export const channelRoute = pgTable(
  'channel_route',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('cr')),
    organizationId: orgId(),
    provider: text('provider', { enum: MESSAGE_PROVIDERS }).notNull(),
    channel: text('channel', { enum: MESSAGING_CHANNELS }).notNull(),
    address: text('address').notNull(),
    connectionId: text('connection_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    unique('channel_route_provider_channel_address_unique').on(
      table.provider,
      table.channel,
      table.address,
    ),
    foreignKey({
      name: 'channel_route_connection_fk',
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [channelConnection.organizationId, channelConnection.id],
    }).onDelete('cascade'),
    check('channel_route_channel_check', sql`${table.channel} in (${inList(MESSAGING_CHANNELS)})`),
    check('channel_route_provider_check', sql`${table.provider} in (${inList(MESSAGE_PROVIDERS)})`),
    check('channel_route_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export const conversation = pgTable(
  'conversation',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('cv')),
    organizationId: orgId(),
    contactId: text('contact_id').notNull(),
    channel: text('channel', { enum: MESSAGING_CHANNELS }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    lastMessageDirection: text('last_message_direction', { enum: MESSAGE_DIRECTIONS }),
    lastMessageStatus: text('last_message_status'),
    unreadCount: integer('unread_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'conversation_contact_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contact.organizationId, contact.id],
    }).onDelete('cascade'),
    unique('conversation_organization_id_contact_id_channel_unique').on(
      table.organizationId,
      table.contactId,
      table.channel,
    ),
    unique('conversation_organization_id_id_unique').on(table.organizationId, table.id),
    index('conversation_inbox_idx').on(
      table.organizationId,
      table.lastActivityAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    check('conversation_channel_check', sql`${table.channel} in (${inList(MESSAGING_CHANNELS)})`),
    check(
      'conversation_last_message_direction_check',
      sql`${table.lastMessageDirection} is null or ${table.lastMessageDirection} in (${inList(MESSAGE_DIRECTIONS)})`,
    ),
    check('conversation_unread_count_check', sql`${table.unreadCount} >= 0`),
    check('conversation_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export const messageTemplate = pgTable(
  'message_template',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('mt')),
    organizationId: orgId(),
    name: text('name').notNull(),
    channel: text('channel', { enum: MESSAGING_CHANNELS }).notNull(),
    body: text('body').notNull(),
    approvalStatus: text('approval_status', { enum: APPROVAL_STATUSES })
      .notNull()
      .default('approved'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    /** The approved Meta template a live WhatsApp send names (lowercase, digits, underscores). */
    whatsappTemplateName: text('whatsapp_template_name'),
    /** The Meta template's language code, such as `en` or `en_US`. */
    whatsappLanguage: text('whatsapp_language'),
  },
  (table) => [
    uniqueIndex('message_template_active_name_unique')
      .on(table.organizationId, table.channel, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
    unique('message_template_organization_id_id_unique').on(table.organizationId, table.id),
    check(
      'message_template_channel_check',
      sql`${table.channel} in (${inList(MESSAGING_CHANNELS)})`,
    ),
    check(
      'message_template_approval_status_check',
      sql`${table.approvalStatus} in (${inList(APPROVAL_STATUSES)})`,
    ),
    check('message_template_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/** Rows are never deleted by the app; only status columns move forward. */
export const message = pgTable(
  'message',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('mg')),
    organizationId: orgId(),
    conversationId: text('conversation_id').notNull(),
    contactId: text('contact_id').notNull(),
    channel: text('channel', { enum: MESSAGING_CHANNELS }).notNull(),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    body: text('body').notNull(),
    templateId: text('template_id'),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    provider: text('provider', { enum: MESSAGE_PROVIDERS }).notNull(),
    providerMessageId: text('provider_message_id'),
    clientMessageId: text('client_message_id'),
    authorUserId: text('author_user_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    statusUpdatedAt: timestamp('status_updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    /** The channel's own id for the message (WhatsApp's wamid), for replies and reactions. */
    channelMessageId: text('channel_message_id'),
    /** The message (same conversation) this one replies to. */
    replyToMessageId: text('reply_to_message_id'),
    /**
     * The provider request of a queued outbound message, written with it and cleared once the
     * provider answered. Never credentials.
     */
    dispatchPayload: jsonb('dispatch_payload'),
    /** Set by the one worker that hands the message to the provider (exactly once). */
    dispatchClaimedAt: timestamp('dispatch_claimed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'message_conversation_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversation.organizationId, conversation.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'message_template_fk',
      columns: [table.organizationId, table.templateId],
      foreignColumns: [messageTemplate.organizationId, messageTemplate.id],
    }),
    unique('message_organization_id_provider_provider_message_id_unique').on(
      table.organizationId,
      table.provider,
      table.providerMessageId,
    ),
    unique('message_organization_id_client_message_id_unique').on(
      table.organizationId,
      table.clientMessageId,
    ),
    unique('message_organization_id_id_unique').on(table.organizationId, table.id),
    index('message_channel_message_idx').on(table.organizationId, table.channelMessageId),
    index('message_dispatch_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'queued' and ${table.dispatchPayload} is not null`),
    index('message_conversation_idx').on(
      table.conversationId,
      table.occurredAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    check('message_channel_check', sql`${table.channel} in (${inList(MESSAGING_CHANNELS)})`),
    check('message_direction_check', sql`${table.direction} in (${inList(MESSAGE_DIRECTIONS)})`),
    check('message_status_check', sql`${table.status} in (${inList(MESSAGE_STATUSES)})`),
    check('message_provider_check', sql`${table.provider} in (${inList(MESSAGE_PROVIDERS)})`),
    check('message_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/** Append-only delivery history. */
export const messageStatusEvent = pgTable(
  'message_status_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ms')),
    organizationId: orgId(),
    messageId: text('message_id').notNull(),
    status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
    applied: boolean('applied').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    rawEventId: text('raw_event_id'),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'message_status_event_message_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [message.organizationId, message.id],
    }).onDelete('cascade'),
    index('message_status_event_message_idx').on(table.messageId, table.occurredAt, table.id),
    check(
      'message_status_event_status_check',
      sql`${table.status} in (${inList(MESSAGE_STATUSES)})`,
    ),
    check('message_status_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export const ATTACHMENT_DIRECTIONS = MESSAGE_DIRECTIONS;

/**
 * A file carried by a message: an image, voice note, audio, video, document or sticker. An outbound
 * upload is a draft (no `message_id`) until a send names it. The bytes live in object storage under
 * `storage_key`; an inbound file is `pending` until it is downloaded from the provider.
 */
export const messageAttachment = pgTable(
  'message_attachment',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ma')),
    organizationId: orgId(),
    conversationId: text('conversation_id').notNull(),
    messageId: text('message_id'),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    kind: text('kind', { enum: ATTACHMENT_KINDS }).notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes'),
    fileName: text('file_name'),
    status: text('status', { enum: ATTACHMENT_STATUSES }).notNull().default('pending'),
    storageKey: text('storage_key'),
    /** Inbound: the provider's media id, for downloading it when no hosted URL came. */
    providerMediaId: text('provider_media_id'),
    /** Inbound: the provider-hosted URL. Server-side only, never sent to the Desk. */
    sourceUrl: text('source_url'),
    sha256: text('sha256'),
    durationMs: integer('duration_ms'),
    /** Up to 48 comma-separated bars from 0 to 100 (core WAVEFORM_BARS). */
    waveform: text('waveform'),
    uploadedBy: text('uploaded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'message_attachment_message_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [message.organizationId, message.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'message_attachment_conversation_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversation.organizationId, conversation.id],
    }).onDelete('cascade'),
    index('message_attachment_message_idx').on(table.messageId),
    check(
      'message_attachment_direction_check',
      sql`${table.direction} in (${inList(MESSAGE_DIRECTIONS)})`,
    ),
    check('message_attachment_kind_check', sql`${table.kind} in (${inList(ATTACHMENT_KINDS)})`),
    check(
      'message_attachment_status_check',
      sql`${table.status} in (${inList(ATTACHMENT_STATUSES)})`,
    ),
    check(
      'message_attachment_size_check',
      sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`,
    ),
    check('message_attachment_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export const REACTION_STATUSES = ['pending', 'sent', 'failed'] as const;
export type ReactionStatus = (typeof REACTION_STATUSES)[number];

/**
 * One emoji reaction per side per message: `inbound` is the contact's, `outbound` the workspace's.
 * Removing a reaction deletes its row.
 */
export const messageReaction = pgTable(
  'message_reaction',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('mr')),
    organizationId: orgId(),
    messageId: text('message_id').notNull(),
    direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
    emoji: text('emoji').notNull(),
    status: text('status', { enum: REACTION_STATUSES }).notNull().default('sent'),
    actorUserId: text('actor_user_id'),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: 'message_reaction_message_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [message.organizationId, message.id],
    }).onDelete('cascade'),
    unique('message_reaction_message_direction_unique').on(table.messageId, table.direction),
    check(
      'message_reaction_direction_check',
      sql`${table.direction} in (${inList(MESSAGE_DIRECTIONS)})`,
    ),
    check('message_reaction_status_check', sql`${table.status} in (${inList(REACTION_STATUSES)})`),
    check('message_reaction_emoji_not_empty', sql`${table.emoji} <> ''`),
    check('message_reaction_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type MessageAttachment = typeof messageAttachment.$inferSelect;
export type MessageReaction = typeof messageReaction.$inferSelect;
export type ChannelConnection = typeof channelConnection.$inferSelect;
export type ChannelRoute = typeof channelRoute.$inferSelect;
export type Conversation = typeof conversation.$inferSelect;
export type MessageTemplate = typeof messageTemplate.$inferSelect;
export type Message = typeof message.$inferSelect;
export type MessageStatusEvent = typeof messageStatusEvent.$inferSelect;

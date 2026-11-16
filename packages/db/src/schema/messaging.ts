import { MESSAGE_STATUSES, MESSAGING_CHANNELS, newId, REGISTRATION_STATUSES } from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
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

export type ChannelConnection = typeof channelConnection.$inferSelect;
export type ChannelRoute = typeof channelRoute.$inferSelect;
export type Conversation = typeof conversation.$inferSelect;
export type MessageTemplate = typeof messageTemplate.$inferSelect;
export type Message = typeof message.$inferSelect;
export type MessageStatusEvent = typeof messageStatusEvent.$inferSelect;

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { MESSAGING_CHANNELS, type MessageStatus, type MessagingChannel } from '@knoqra/core';
import {
  contact,
  conversation,
  type Database,
  type Tx,
  timelineEvent,
  user,
  withTenant,
} from '@knoqra/db';
import { and, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { CONTACT_ID_PATTERN, findContact, writableAccess } from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import {
  decodeConversationCursor,
  decodeTimelineCursor,
  encodeConversationCursor,
  encodeTimelineCursor,
} from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import { loadMessageExtras } from '../messaging/attachments';
import { auditMessagingAlone, insertMessagingAudit } from '../messaging/audit';
import { composerFor } from '../messaging/composer';
import {
  type ComposerSchema,
  ConversationDetailSchema,
  ConversationSchema,
  composerJson,
  isReplyable,
  type MessageExtras,
  NO_EXTRAS,
  type ThreadItemJson,
  ThreadItemSchema,
} from '../messaging/json';
import { senderFor } from '../messaging/senders';
import { type ConversationRow, ensureConversation } from '../messaging/store';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 1024;
const MAX_NOTE_LENGTH = 4000;
const MIN_PHONE_DIGITS = 3;
const CONVERSATION_ID_PATTERN = /^cv_[0-9a-f]{32}$/;

const ConversationIdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

const ListQuery = z.object({
  filter: z.enum(['all', 'unread', 'sms', 'whatsapp']).default('all'),
  q: safeText({ max: 100 }).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});
const ItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});
const CreateBody = z
  .object({ contactId: z.string().min(1).max(64), channel: z.enum(MESSAGING_CHANNELS) })
  .openapi('CreateConversation');
const NoteBody = z
  .object({ body: safeText({ min: 1, max: MAX_NOTE_LENGTH }) })
  .openapi('CreateConversationNote');

const ConversationPageSchema = z
  .object({ items: z.array(ConversationSchema), nextCursor: z.string().nullable() })
  .openapi('ConversationPage');
const ThreadPageSchema = z
  .object({ items: z.array(ThreadItemSchema), nextCursor: z.string().nullable() })
  .openapi('ThreadPage');

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/conversations',
  tags: ['conversations'],
  summary: 'Conversations of the active organization, most recent activity first',
  security,
  request: { query: ListQuery },
  responses: {
    200: { description: 'Conversation page', content: json(okEnvelope(ConversationPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/v1/conversations',
  tags: ['conversations'],
  summary: 'Open (or fetch) the conversation for a contact and channel',
  security,
  request: { body: { required: true, content: json(CreateBody) } },
  responses: {
    200: { description: 'Existing conversation', content: json(okEnvelope(ConversationSchema)) },
    201: { description: 'Created conversation', content: json(okEnvelope(ConversationSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('The contact is archived or merged'),
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/api/v1/conversations/{id}',
  tags: ['conversations'],
  summary: 'One conversation with its sender',
  security,
  request: { params: ConversationIdParam },
  responses: {
    200: { description: 'Conversation', content: json(okEnvelope(ConversationDetailSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such conversation in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const itemsRoute = createRoute({
  method: 'get',
  path: '/api/v1/conversations/{id}/items',
  tags: ['conversations'],
  summary: 'A page of messages and notes of a conversation, newest first',
  security,
  request: { params: ConversationIdParam, query: ItemsQuery },
  responses: {
    200: { description: 'Thread page', content: json(okEnvelope(ThreadPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such conversation in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const noteRoute = createRoute({
  method: 'post',
  path: '/api/v1/conversations/{id}/notes',
  tags: ['conversations'],
  summary: 'Add an internal note to a conversation',
  security,
  request: { params: ConversationIdParam, body: { required: true, content: json(NoteBody) } },
  responses: {
    201: { description: 'Created note', content: json(okEnvelope(ThreadItemSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such conversation in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const readRoute = createRoute({
  method: 'post',
  path: '/api/v1/conversations/{id}/read',
  tags: ['conversations'],
  summary: 'Mark a conversation as read',
  security,
  request: { params: ConversationIdParam },
  responses: {
    204: { description: 'Marked read' },
    401: errorResponse('No valid session'),
    404: errorResponse('No such conversation in the active organization'),
    409: errorResponse('No active organization'),
  },
});

/** Microsecond-precision ISO text, so a keyset cursor never rounds a row away. */
const isoKey = (column: SQL | unknown) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Name or phone substring. sort_name is the stored lower(display_name) (ruling R1), and ILIKE on a
 * UTF-8 database lowers both sides with lower() before matching, so `sort_name LIKE lower(p)`
 * matches exactly the rows `display_name ILIKE p` did, with one comparison per row (ruling R2).
 */
function searchCondition(q: string): SQL | undefined {
  if (q.length === 0) return undefined;
  const digits = q.replace(/\D/g, '');
  return or(
    sql`${contact.sortName} like lower(${`%${escapeLike(q)}%`})`,
    digits.length >= MIN_PHONE_DIGITS ? sql`${contact.phoneE164} like ${`%${digits}%`}` : undefined,
  );
}

interface ListedRow {
  conv: ConversationRow;
  contact: { id: string; displayName: string; phoneE164: string; company: string | null };
  key: string;
}

const contactColumns = {
  id: contact.id,
  displayName: contact.displayName,
  phoneE164: contact.phoneE164,
  company: contact.company,
};

function conversationJson(row: ListedRow, composer: z.infer<typeof ComposerSchema>) {
  const { conv } = row;
  return {
    id: conv.id,
    channel: conv.channel,
    contact: {
      id: row.contact.id,
      displayName: row.contact.displayName,
      phone: row.contact.phoneE164,
      company: row.contact.company,
    },
    lastActivityAt: conv.lastActivityAt.toISOString(),
    lastInboundAt: conv.lastInboundAt ? conv.lastInboundAt.toISOString() : null,
    lastMessagePreview: conv.lastMessagePreview,
    lastMessageDirection: conv.lastMessageDirection,
    lastMessageStatus: conv.lastMessageStatus,
    unreadCount: conv.unreadCount,
    composer,
  };
}

async function loadConversation(tx: Tx, id: string): Promise<ListedRow | undefined> {
  const [row] = await tx
    .select({
      conv: conversation,
      contact: contactColumns,
      key: isoKey(conversation.lastActivityAt),
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(eq(conversation.id, id))
    .limit(1);
  return row;
}

async function notFoundResponse(
  c: Parameters<typeof fail>[0],
  db: Database,
  tenant: Tenant,
  action: 'conversation.read' | 'conversation.note.create',
  id: string | null,
) {
  await auditMessagingAlone(db, tenant, {
    action,
    entityType: 'conversation',
    outcome: 'not_found',
    entityId: id,
    metadata: id === null ? { reason: 'malformed_id' } : {},
  });
  return fail(c, 404, 'not_found', 'Conversation not found.');
}

interface ThreadRow extends Record<string, unknown> {
  kind: 'message' | 'note';
  id: string;
  occurred_key: string;
  conversation_id: string | null;
  channel: MessagingChannel | null;
  direction: 'inbound' | 'outbound' | null;
  body: string;
  template_id: string | null;
  template_name: string | null;
  status: string | null;
  error_code: string | null;
  error_message: string | null;
  author_user_id: string | null;
  author_name: string | null;
  provider_message_id: string | null;
  status_updated_key: string | null;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  channel_message_id: string | null;
}

const toIso = (key: string): string => new Date(key).toISOString();

function threadItemJson(row: ThreadRow, extras: MessageExtras = NO_EXTRAS): ThreadItemJson {
  if (row.kind === 'note') {
    return {
      kind: 'note',
      note: {
        id: row.id,
        body: row.body,
        authorUserId: row.author_user_id,
        authorName: row.author_name,
        occurredAt: toIso(row.occurred_key),
      },
    };
  }
  return {
    kind: 'message',
    message: {
      id: row.id,
      conversationId: row.conversation_id as string,
      channel: row.channel as MessagingChannel,
      direction: row.direction as 'inbound' | 'outbound',
      body: row.body,
      templateId: row.template_id,
      templateName: row.template_name,
      status: row.status as MessageStatus,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
      authorUserId: row.author_user_id,
      providerMessageId: row.provider_message_id,
      clientMessageId: row.client_message_id,
      occurredAt: toIso(row.occurred_key),
      statusUpdatedAt: toIso(row.status_updated_key ?? row.occurred_key),
      ...extras,
      replyable: isReplyable({
        channel: row.channel as string,
        direction: row.direction as string,
        channelMessageId: row.channel_message_id,
      }),
    },
  };
}

const KEY_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/**
 * Messages and conversation notes as one stream; ids never collide (mg_ vs te_ prefixes).
 * The keyset, order and limit run inside each branch, so each reads only its page from its index
 * (message_conversation_idx, timeline_event_conversation_ref_idx); the outer merge then keeps the
 * newest `limit + 1`. The newest n rows of a union are the newest n of the two branches' newest n,
 * so the page is the one the single outer keyset returned.
 */
async function threadPage(
  tx: Tx,
  conversationId: string,
  limit: number,
  cursor: { occurredAt: string; id: string } | undefined,
): Promise<ThreadRow[]> {
  const keyed = (col: string) => sql.raw(`to_char(${col} at time zone 'UTC', ${KEY_FORMAT})`);
  const before = (alias: 'm' | 'te') =>
    cursor
      ? sql`and (${sql.raw(`${alias}.occurred_at`)}, ${sql.raw(`${alias}.id`)}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
      : sql``;
  const take = limit + 1;
  const result = await tx.execute<ThreadRow>(sql`
    select * from (
      (select 'message'::text as kind, m.id, m.occurred_at, ${keyed('m.occurred_at')} as occurred_key,
        m.conversation_id, m.channel, m.direction, m.body, m.template_id, t.name as template_name,
        m.status, m.error_code, m.error_message, m.author_user_id, null::text as author_name,
        m.provider_message_id, ${keyed('m.status_updated_at')} as status_updated_key,
        m.client_message_id, m.reply_to_message_id, m.channel_message_id
      from message m
      left join message_template t on t.id = m.template_id and t.organization_id = m.organization_id
      where m.conversation_id = ${conversationId} ${before('m')}
      order by m.occurred_at desc, m.id desc
      limit ${take})
      union all
      (select 'note'::text, te.id, te.occurred_at, ${keyed('te.occurred_at')},
        null, null, null, te.body, null, null,
        null, null, null, te.actor_user_id, u.name,
        null, null, null, null, null
      from timeline_event te
      left join "user" u on u.id = te.actor_user_id
      where te.kind = 'note' and te.ref_type = 'conversation' and te.ref_id = ${conversationId}
        ${before('te')}
      order by te.occurred_at desc, te.id desc
      limit ${take})
    ) x
    order by x.occurred_at desc, x.id desc
    limit ${take}`);
  return result.rows;
}

function parseCursor(raw: string | undefined) {
  if (raw === undefined) return { ok: true as const, value: undefined };
  const decoded = decodeTimelineCursor(raw);
  return decoded.ok ? { ok: true as const, value: decoded.value } : { ok: false as const };
}

async function listPage(
  tx: Tx,
  env: Env,
  query: z.infer<typeof ListQuery>,
  cursor: { lastActivityAt: string; id: string } | undefined,
) {
  const where = and(
    query.filter === 'unread' ? sql`${conversation.unreadCount} > 0` : undefined,
    query.filter === 'sms' || query.filter === 'whatsapp'
      ? eq(conversation.channel, query.filter)
      : undefined,
    searchCondition(query.q ?? ''),
    cursor
      ? sql`(${conversation.lastActivityAt}, ${conversation.id}) < (${cursor.lastActivityAt}::timestamptz, ${cursor.id})`
      : undefined,
  );
  const rows = await tx
    .select({
      conv: conversation,
      contact: contactColumns,
      key: isoKey(conversation.lastActivityAt),
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(where)
    .orderBy(desc(conversation.lastActivityAt), desc(conversation.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const composers = await composerFor(
    tx,
    env,
    page.map((r) => r.conv),
    new Date(),
  );
  const last = page.at(-1);
  return {
    items: page.map((r) =>
      conversationJson(
        r,
        composerJson(composers.get(r.conv.id) as NonNullable<ReturnType<typeof composers.get>>),
      ),
    ),
    nextCursor:
      rows.length > query.limit && last
        ? encodeConversationCursor({ lastActivityAt: last.key, id: last.conv.id })
        : null,
  };
}

export const conversations = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: { lastActivityAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeConversationCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const page = await withTenant(db, tenant.orgId, (tx) => listPage(tx, c.env, query, cursor));
    return ok(c, page, 200);
  })
  .openapi(createConversationRoute, async (c) => {
    const { db, tenant } = c.var;
    const { contactId, channel } = c.req.valid('json');
    const refuse = async (outcome: 'not_found' | 'denied', reason: string, status: 404 | 422) => {
      await auditMessagingAlone(db, tenant, {
        action: 'conversation.create',
        entityType: 'conversation',
        outcome,
        metadata: { contactId, reason },
      });
      return status === 404
        ? fail(c, 404, 'not_found', 'Contact not found.')
        : fail(
            c,
            422,
            'validation_error',
            reason === 'merged' ? 'Merged contacts cannot be edited' : 'Restore this contact first',
          );
    };
    if (!CONTACT_ID_PATTERN.test(contactId)) return refuse('not_found', 'malformed_id', 404);
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const access = writableAccess(await findContact(tx, contactId, true));
      if (access.kind !== 'ok') return { refused: access.kind } as const;
      const [existing] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(and(eq(conversation.contactId, contactId), eq(conversation.channel, channel)))
        .limit(1);
      const row = await ensureConversation(tx, tenant.orgId, contactId, channel);
      await insertMessagingAudit(tx, tenant, {
        action: 'conversation.create',
        entityType: 'conversation',
        outcome: 'allowed',
        entityId: row.id,
        metadata: { created: existing === undefined },
      });
      const listed = await loadConversation(tx, row.id);
      if (!listed) throw new Error('conversation vanished after upsert');
      const composers = await composerFor(tx, c.env, [listed.conv], new Date());
      const state = composers.get(row.id);
      if (!state) throw new Error('composer state missing');
      return { listed, state, created: existing === undefined } as const;
    });
    if ('refused' in result) {
      const reason: string = result.refused ?? 'not_found';
      return reason === 'not_found'
        ? refuse('not_found', reason, 404)
        : refuse('denied', reason, 422);
    }
    return ok(
      c,
      conversationJson(result.listed, composerJson(result.state)),
      result.created ? 201 : 200,
    );
  })
  .openapi(detailRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONVERSATION_ID_PATTERN.test(id)) {
      return notFoundResponse(c, db, tenant, 'conversation.read', null);
    }
    const found = await withTenant(db, tenant.orgId, async (tx) => {
      const listed = await loadConversation(tx, id);
      if (!listed) return undefined;
      // Both load the Telnyx credential flag lazily, only for a telnyx sender.
      const composers = await composerFor(tx, c.env, [listed.conv], new Date());
      const sender = await senderFor(tx, c.env, listed.conv.channel);
      return { listed, state: composers.get(id), sender };
    });
    if (!found?.state) return notFoundResponse(c, db, tenant, 'conversation.read', id);
    return ok(
      c,
      { ...conversationJson(found.listed, composerJson(found.state)), sender: found.sender },
      200,
    );
  })
  .openapi(itemsRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONVERSATION_ID_PATTERN.test(id)) {
      return notFoundResponse(c, db, tenant, 'conversation.read', null);
    }
    const query = c.req.valid('query');
    const cursor = parseCursor(query.cursor);
    if (!cursor.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
    const found = await withTenant(db, tenant.orgId, async (tx) => {
      if (!(await loadConversation(tx, id))) return undefined;
      const rows = await threadPage(tx, id, query.limit, cursor.value);
      const messages = rows.slice(0, query.limit).filter((r) => r.kind === 'message');
      const replies = new Map(
        messages
          .filter((r) => r.reply_to_message_id)
          .map((r) => [r.id, r.reply_to_message_id as string] as const),
      );
      const extras = await loadMessageExtras(
        tx,
        c.env,
        messages.map((r) => r.id),
        replies,
      );
      return { rows, extras };
    });
    if (!found) return notFoundResponse(c, db, tenant, 'conversation.read', id);
    const { rows, extras } = found;
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeTimelineCursor({ occurredAt: last.occurred_key, id: last.id })
        : null;
    return ok(
      c,
      { items: page.map((row) => threadItemJson(row, extras.get(row.id))), nextCursor },
      200,
    );
  })
  .openapi(noteRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONVERSATION_ID_PATTERN.test(id)) {
      return notFoundResponse(c, db, tenant, 'conversation.note.create', null);
    }
    const { body } = c.req.valid('json');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const listed = await loadConversation(tx, id);
      if (!listed) return undefined;
      const [note] = await tx
        .insert(timelineEvent)
        .values({
          organizationId: tenant.orgId,
          contactId: listed.conv.contactId,
          kind: 'note',
          title: 'Note',
          body,
          actorUserId: tenant.userId,
          source: 'inbox',
          refType: 'conversation',
          refId: id,
          occurredAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!note) throw new Error('note insert returned no row');
      const [author] = await tx
        .select({ name: user.name })
        .from(user)
        .where(eq(user.id, tenant.userId))
        .limit(1);
      // Never the note body: it is PII.
      await insertMessagingAudit(tx, tenant, {
        action: 'conversation.note.create',
        entityType: 'conversation',
        outcome: 'allowed',
        entityId: id,
      });
      return { note, authorName: author?.name ?? null };
    });
    if (!result) return notFoundResponse(c, db, tenant, 'conversation.note.create', id);
    return ok(
      c,
      {
        kind: 'note' as const,
        note: {
          id: result.note.id,
          body: result.note.body ?? '',
          authorUserId: result.note.actorUserId,
          authorName: result.authorName,
          occurredAt: result.note.occurredAt.toISOString(),
        },
      },
      201,
    );
  })
  .openapi(readRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONVERSATION_ID_PATTERN.test(id)) {
      return notFoundResponse(c, db, tenant, 'conversation.read', null);
    }
    const updated = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .update(conversation)
        .set({ unreadCount: 0 })
        .where(eq(conversation.id, id))
        .returning({ id: conversation.id }),
    );
    if (updated.length === 0) return notFoundResponse(c, db, tenant, 'conversation.read', id);
    return c.body(null, 204);
  });

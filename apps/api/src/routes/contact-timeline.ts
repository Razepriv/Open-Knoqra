import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { type TimelineEventRow, timelineEvent, withTenant } from '@knoqra/db';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import {
  CONTACT_ID_PATTERN,
  ContactIdParam,
  findContact,
  insertContactAudit,
  notFound,
  refuseAccess,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv } from '../lib/context';
import { decodeTimelineCursor, encodeTimelineCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 1024;
const MAX_NOTE_LENGTH = 4000;

export const TimelineEventSchema = z
  .object({
    id: z.string().openapi({ example: 'te_0123456789abcdef0123456789abcdef' }),
    contactId: z.string(),
    kind: z.enum(['note', 'consent', 'system', 'call', 'message', 'task']),
    title: z.string(),
    body: z.string().nullable(),
    actorUserId: z.string().nullable(),
    source: z.string(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    occurredAt: z.iso.datetime(),
  })
  .openapi('TimelineEvent');
export type TimelineEventJson = z.infer<typeof TimelineEventSchema>;

const TimelinePageSchema = z
  .object({ items: z.array(TimelineEventSchema), nextCursor: z.string().nullable() })
  .openapi('TimelinePage');

const KINDS = {
  all: undefined,
  calls: ['call'],
  messages: ['message'],
  notes_consent: ['note', 'consent'],
} as const;

const TimelineQuery = z.object({
  kind: z.enum(['all', 'calls', 'messages', 'notes_consent']).default('all'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const NoteBody = z
  .object({ body: safeText({ min: 1, max: MAX_NOTE_LENGTH }) })
  .openapi('CreateNote');

export function toTimelineJson(row: TimelineEventRow): TimelineEventJson {
  return {
    id: row.id,
    contactId: row.contactId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    actorUserId: row.actorUserId,
    source: row.source,
    refType: row.refType,
    refId: row.refId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const timelineRoute = createRoute({
  method: 'get',
  path: '/api/v1/contacts/{id}/timeline',
  tags: ['contacts'],
  summary: "A page of a contact's timeline, newest first",
  security,
  request: { params: ContactIdParam, query: TimelineQuery },
  responses: {
    200: { description: 'Timeline page', content: json(okEnvelope(TimelinePageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
  },
});

const noteRoute = createRoute({
  method: 'post',
  path: '/api/v1/contacts/{id}/notes',
  tags: ['contacts'],
  summary: 'Add a note to a contact',
  security,
  request: { params: ContactIdParam, body: { required: true, content: json(NoteBody) } },
  responses: {
    201: { description: 'Created note', content: json(okEnvelope(TimelineEventSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('The contact is archived or merged'),
  },
});

/** Microsecond-precision ISO text of occurred_at, so a keyset cursor never rounds a row away. */
const occurredKey = sql<string>`to_char(${timelineEvent.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const contactTimeline = new OpenAPIHono<AppEnv>()
  .openapi(timelineRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.timeline.read');
    }
    const query = c.req.valid('query');
    let cursor: { occurredAt: string; id: string } | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded.ok) return fail(c, 400, 'validation_error', 'Invalid cursor');
      cursor = decoded.value;
    }
    const kinds = KINDS[query.kind];
    const where: (SQL | undefined)[] = [
      eq(timelineEvent.contactId, id),
      kinds ? inArray(timelineEvent.kind, [...kinds]) : undefined,
      cursor
        ? sql`(${timelineEvent.occurredAt}, ${timelineEvent.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
        : undefined,
    ];
    const rows = await withTenant(db, tenant.orgId, async (tx) => {
      if (!(await findContact(tx, id, false))) return undefined;
      return tx
        .select({ row: timelineEvent, key: occurredKey })
        .from(timelineEvent)
        .where(and(...where))
        .orderBy(desc(timelineEvent.occurredAt), desc(timelineEvent.id))
        .limit(query.limit + 1);
    });
    if (!rows) return notFound(c, db, tenant, 'contact.timeline.read', id);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeTimelineCursor({ occurredAt: last.key, id: last.row.id })
        : null;
    return ok(c, { items: page.map((r) => toTimelineJson(r.row)), nextCursor }, 200);
  })
  .openapi(noteRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!CONTACT_ID_PATTERN.test(id)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.note.create');
    }
    const { body } = c.req.valid('json');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const access = writableAccess(await findContact(tx, id, true));
      if (access.kind !== 'ok') return { refused: access.kind } as const;
      const [note] = await tx
        .insert(timelineEvent)
        .values({
          organizationId: tenant.orgId,
          contactId: id,
          kind: 'note',
          title: 'Note',
          body,
          actorUserId: tenant.userId,
          source: 'app',
          occurredAt: sql`clock_timestamp()`,
        })
        .returning();
      if (!note) throw new Error('note insert returned no row');
      // Never the note body: it is PII.
      await insertContactAudit(tx, tenant, {
        action: 'contact.note.create',
        outcome: 'allowed',
        entityId: id,
      });
      return { note } as const;
    });
    if (result.refused) {
      return refuseAccess(c, db, tenant, 'contact.note.create', id, result.refused);
    }
    return ok(c, toTimelineJson(result.note), 201);
  });

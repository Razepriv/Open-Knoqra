import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  contact,
  notification,
  type TaskRow,
  type Tx,
  task,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import { and, asc, desc, eq, isNull, type SQL, sql } from 'drizzle-orm';
import {
  CONTACT_ID_PATTERN,
  findContact,
  notFound,
  refuseAccess,
  rejectMalformedContactId,
  writableAccess,
} from '../lib/contact-access';
import type { AppEnv, Tenant } from '../lib/context';
import { decodeTaskCursor, encodeTaskCursor } from '../lib/cursor';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { safeText } from '../lib/schemas';
import {
  insertTaskAudit,
  TASK_ID_PATTERN,
  type TaskAuditAction,
  TaskIdParam,
  taskNotFound,
} from '../lib/task-access';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_CURSOR_LENGTH = 1024;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;

export const TaskSchema = z
  .object({
    id: z.string().openapi({ example: 'tk_0123456789abcdef0123456789abcdef' }),
    title: z.string(),
    notes: z.string().nullable(),
    dueAt: z.iso.datetime().nullable(),
    remindAt: z.iso.datetime().nullable(),
    status: z.enum(['open', 'done']),
    completedAt: z.iso.datetime().nullable(),
    contact: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Task');
export type TaskJson = z.infer<typeof TaskSchema>;

const TaskPageSchema = z
  .object({ items: z.array(TaskSchema), nextCursor: z.string().nullable() })
  .openapi('TaskPage');

const TaskListQuery = z.object({
  status: z.enum(['open', 'done']).default('open'),
  contactId: z.string().regex(CONTACT_ID_PATTERN).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
});

const isoWithOffset = z.iso.datetime({ offset: true });

const CreateTaskBody = z
  .object({
    title: safeText({ min: 1, max: MAX_TITLE_LENGTH }),
    notes: safeText({ max: MAX_NOTES_LENGTH }).optional(),
    dueAt: isoWithOffset.optional(),
    remindAt: isoWithOffset.optional(),
    contactId: z.string().min(1).max(64).optional(),
  })
  .openapi('CreateTask');

const UpdateTaskBody = z
  .object({
    title: safeText({ min: 1, max: MAX_TITLE_LENGTH }),
    notes: safeText({ max: MAX_NOTES_LENGTH }).nullable(),
    dueAt: isoWithOffset.nullable(),
    remindAt: isoWithOffset.nullable(),
    status: z.enum(['open', 'done']),
  })
  .partial()
  .refine((body) => Object.values(body).some((v) => v !== undefined), 'Nothing to update')
  .openapi('UpdateTask');

export function toTaskJson(row: TaskRow, contactRef: { id: string; displayName: string } | null) {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    dueAt: row.dueAt?.toISOString() ?? null,
    remindAt: row.remindAt?.toISOString() ?? null,
    status: row.status,
    completedAt: row.completedAt?.toISOString() ?? null,
    contact: contactRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } satisfies TaskJson;
}

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/tasks',
  tags: ['tasks'],
  summary: "A page of the signed-in user's tasks",
  security,
  request: { query: TaskListQuery },
  responses: {
    200: { description: 'Task page', content: json(okEnvelope(TaskPageSchema)) },
    400: errorResponse('Invalid query or cursor'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const createTaskRoute = createRoute({
  method: 'post',
  path: '/api/v1/tasks',
  tags: ['tasks'],
  summary: 'Add a task, optionally about a contact',
  security,
  request: { body: { required: true, content: json(CreateTaskBody) } },
  responses: {
    201: { description: 'Created task', content: json(okEnvelope(TaskSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such contact in the active organization'),
    409: errorResponse('No active organization'),
    422: errorResponse('The contact is archived or merged'),
  },
});

const updateTaskRoute = createRoute({
  method: 'patch',
  path: '/api/v1/tasks/{id}',
  tags: ['tasks'],
  summary: 'Edit, complete or reopen a task',
  security,
  request: { params: TaskIdParam, body: { required: true, content: json(UpdateTaskBody) } },
  responses: {
    200: { description: 'Updated task', content: json(okEnvelope(TaskSchema)) },
    400: errorResponse('Body failed validation'),
    401: errorResponse('No valid session'),
    404: errorResponse('No such task'),
    409: errorResponse('No active organization'),
  },
});

const deleteTaskRoute = createRoute({
  method: 'delete',
  path: '/api/v1/tasks/{id}',
  tags: ['tasks'],
  summary: 'Delete a task',
  security,
  request: { params: TaskIdParam },
  responses: {
    204: { description: 'Deleted' },
    401: errorResponse('No valid session'),
    404: errorResponse('No such task'),
    409: errorResponse('No active organization'),
  },
});

const TS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
/** Microsecond-precision keys, so a keyset cursor never rounds a row away. */
const dueKey = sql<string>`case when ${task.dueAt} is null then 'infinity' else to_char(${task.dueAt} at time zone 'UTC', ${sql.raw(`'${TS_FORMAT}'`)}) end`;
const createdKey = sql<string>`to_char(${task.createdAt} at time zone 'UTC', ${sql.raw(`'${TS_FORMAT}'`)})`;
const completedKey = sql<string>`to_char(${task.completedAt} at time zone 'UTC', ${sql.raw(`'${TS_FORMAT}'`)})`;

type ContactRef = { id: string; displayName: string } | null;

async function contactRefOf(tx: Tx, contactId: string | null): Promise<ContactRef> {
  if (!contactId) return null;
  const [row] = await tx
    .select({ id: contact.id, displayName: contact.displayName })
    .from(contact)
    .where(eq(contact.id, contactId))
    .limit(1);
  return row ?? null;
}

/** Appends a task entry to the contact's timeline, unless the contact is read-only now. */
async function appendTimeline(tx: Tx, tenant: Tenant, row: TaskRow, title: string): Promise<void> {
  if (!row.contactId) return;
  const access = writableAccess(await findContact(tx, row.contactId, true));
  if (access.kind !== 'ok') return;
  await tx.insert(timelineEvent).values({
    organizationId: tenant.orgId,
    contactId: row.contactId,
    kind: 'task',
    title,
    body: null,
    actorUserId: tenant.userId,
    source: 'app',
    refType: 'task',
    refId: row.id,
    occurredAt: sql`clock_timestamp()`,
  });
}

/** A finished (done or deleted) task's unread reminders stop asking for attention. */
async function readTaskNotifications(tx: Tx, tenant: Tenant, taskId: string): Promise<void> {
  await tx
    .update(notification)
    .set({ readAt: sql`clock_timestamp()` as unknown as Date })
    .where(
      and(
        eq(notification.organizationId, tenant.orgId),
        eq(notification.userId, tenant.userId),
        eq(notification.refType, 'task'),
        eq(notification.refId, taskId),
        isNull(notification.readAt),
      ),
    );
}

function patchValues(body: z.infer<typeof UpdateTaskBody>, current: TaskRow) {
  const values: Partial<typeof task.$inferInsert> = {};
  if (body.title !== undefined) values.title = body.title;
  if (body.notes !== undefined) values.notes = body.notes;
  if (body.dueAt !== undefined) values.dueAt = body.dueAt === null ? null : new Date(body.dueAt);
  if (body.remindAt !== undefined) {
    values.remindAt = body.remindAt === null ? null : new Date(body.remindAt);
  }
  let action: TaskAuditAction = 'task.update';
  if (body.status === 'done' && current.status === 'open') {
    values.status = 'done';
    values.completedAt = sql`clock_timestamp()` as unknown as Date;
    action = 'task.complete';
  } else if (body.status === 'open' && current.status === 'done') {
    values.status = 'open';
    values.completedAt = null;
    action = 'task.reopen';
  }
  return { values, action };
}

export const tasks = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    let cursor: ReturnType<typeof decodeTaskCursor> | undefined;
    if (query.cursor !== undefined) {
      cursor = decodeTaskCursor(query.cursor);
      if (!cursor.ok || cursor.value.status !== query.status) {
        return fail(c, 400, 'validation_error', 'Invalid cursor');
      }
    }
    const after = cursor?.ok ? cursor.value : undefined;
    const where: (SQL | undefined)[] = [
      eq(task.ownerUserId, tenant.userId),
      eq(task.status, query.status),
      query.contactId ? eq(task.contactId, query.contactId) : undefined,
    ];
    if (after?.status === 'open') {
      // due_key is the stored coalesce(due_at, 'infinity') (ruling R1): a plain column the index
      // can seek on under RLS, with exactly the expression's value.
      where.push(
        sql`(${task.dueKey}, ${task.createdAt}, ${task.id}) > (${after.due}::timestamptz, ${after.createdAt}::timestamptz, ${after.id})`,
      );
    } else if (after?.status === 'done') {
      where.push(
        sql`(${task.completedAt}, ${task.id}) < (${after.completedAt}::timestamptz, ${after.id})`,
      );
    }
    const order =
      query.status === 'open'
        ? [asc(task.dueKey), asc(task.createdAt), asc(task.id)]
        : [desc(task.completedAt), desc(task.id)];
    const rows = await withTenant(db, tenant.orgId, (tx) =>
      tx
        .select({
          row: task,
          contactId: contact.id,
          contactName: contact.displayName,
          dueKey,
          createdKey,
          completedKey,
        })
        .from(task)
        .leftJoin(contact, and(eq(contact.id, task.contactId)))
        .where(and(...where))
        .orderBy(...order)
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    let nextCursor: string | null = null;
    if (rows.length > query.limit && last) {
      nextCursor =
        query.status === 'open'
          ? encodeTaskCursor({
              status: 'open',
              due: last.dueKey,
              createdAt: last.createdKey,
              id: last.row.id,
            })
          : encodeTaskCursor({ status: 'done', completedAt: last.completedKey, id: last.row.id });
    }
    const items = page.map((r) =>
      toTaskJson(
        r.row,
        r.contactId && r.contactName ? { id: r.contactId, displayName: r.contactName } : null,
      ),
    );
    return ok(c, { items, nextCursor }, 200);
  })
  .openapi(createTaskRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    if (body.contactId !== undefined && !CONTACT_ID_PATTERN.test(body.contactId)) {
      return rejectMalformedContactId(c, db, tenant, 'contact.read');
    }
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      let contactRef: ContactRef = null;
      if (body.contactId) {
        const access = writableAccess(await findContact(tx, body.contactId, true));
        if (access.kind !== 'ok') return { refused: access.kind } as const;
        contactRef = { id: access.row.id, displayName: access.row.displayName };
      }
      const [row] = await tx
        .insert(task)
        .values({
          organizationId: tenant.orgId,
          ownerUserId: tenant.userId,
          contactId: body.contactId ?? null,
          title: body.title,
          notes: body.notes ?? null,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          remindAt: body.remindAt ? new Date(body.remindAt) : null,
        })
        .returning();
      if (!row) throw new Error('task insert returned no row');
      await appendTimeline(tx, tenant, row, `Task added: ${row.title}`);
      await insertTaskAudit(tx, tenant, {
        action: 'task.create',
        outcome: 'allowed',
        entityId: row.id,
      });
      return { row, contactRef } as const;
    });
    if (result.refused) {
      const id = body.contactId ?? '';
      return result.refused === 'not_found'
        ? notFound(c, db, tenant, 'contact.read', id)
        : refuseAccess(c, db, tenant, 'contact.read', id, result.refused);
    }
    return ok(c, toTaskJson(result.row, result.contactRef), 201);
  })
  .openapi(updateTaskRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!TASK_ID_PATTERN.test(id)) {
      return taskNotFound(c, db, tenant, 'task.update', id, true);
    }
    const body = c.req.valid('json');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      const [current] = await tx
        .select()
        .from(task)
        .where(and(eq(task.id, id), eq(task.ownerUserId, tenant.userId)))
        .limit(1)
        .for('update');
      if (!current) return undefined;
      const { values, action } = patchValues(body, current);
      const [row] = await tx.update(task).set(values).where(eq(task.id, id)).returning();
      if (!row) throw new Error('task update returned no row');
      if (action === 'task.complete') {
        await appendTimeline(tx, tenant, row, `Task done: ${row.title}`);
        await readTaskNotifications(tx, tenant, id);
      }
      // Never the title or notes: they are PII.
      await insertTaskAudit(tx, tenant, { action, outcome: 'allowed', entityId: id });
      return { row, contactRef: await contactRefOf(tx, row.contactId) };
    });
    if (!result) return taskNotFound(c, db, tenant, 'task.update', id);
    return ok(c, toTaskJson(result.row, result.contactRef), 200);
  })
  .openapi(deleteTaskRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!TASK_ID_PATTERN.test(id)) {
      return taskNotFound(c, db, tenant, 'task.delete', id, true);
    }
    const deleted = await withTenant(db, tenant.orgId, async (tx) => {
      const rows = await tx
        .delete(task)
        .where(and(eq(task.id, id), eq(task.ownerUserId, tenant.userId)))
        .returning({ id: task.id });
      if (rows.length === 0) return false;
      await readTaskNotifications(tx, tenant, id);
      await insertTaskAudit(tx, tenant, {
        action: 'task.delete',
        outcome: 'allowed',
        entityId: id,
      });
      return true;
    });
    if (!deleted) return taskNotFound(c, db, tenant, 'task.delete', id);
    return c.body(null, 204);
  });

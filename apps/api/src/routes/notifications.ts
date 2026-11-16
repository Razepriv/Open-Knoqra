import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { auditEvent, type NotificationRow, notification, type Tx, withTenant } from '@knoqra/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv, Tenant } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import { materializeReminders } from '../today/reminders';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const NOTIFICATION_ID_PATTERN = /^nt_[0-9a-f]{32}$/;

export const NotificationSchema = z
  .object({
    id: z.string().openapi({ example: 'nt_0123456789abcdef0123456789abcdef' }),
    kind: z.enum(['task_due', 'task_reminder', 'system']),
    title: z.string(),
    body: z.string().nullable(),
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    readAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Notification');

const NotificationFeedSchema = z
  .object({ items: z.array(NotificationSchema), unreadCount: z.number().int().min(0) })
  .openapi('NotificationFeed');

const UnreadSchema = z.object({ unreadCount: z.literal(0) }).openapi('NotificationsRead');

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
const IdParam = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .openapi({ param: { name: 'id', in: 'path' } }),
});

function toJson(row: NotificationRow): z.infer<typeof NotificationSchema> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    refType: row.refType,
    refId: row.refId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/notifications',
  tags: ['notifications'],
  summary: "The signed-in user's notifications, newest first",
  security,
  request: { query: ListQuery },
  responses: {
    200: { description: 'Notifications', content: json(okEnvelope(NotificationFeedSchema)) },
    400: errorResponse('Invalid query'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const readAllRoute = createRoute({
  method: 'post',
  path: '/api/v1/notifications/read-all',
  tags: ['notifications'],
  summary: 'Mark every notification as read',
  security,
  responses: {
    200: { description: 'All read', content: json(okEnvelope(UnreadSchema)) },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const readRoute = createRoute({
  method: 'post',
  path: '/api/v1/notifications/{id}/read',
  tags: ['notifications'],
  summary: 'Mark one notification as read',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The notification', content: json(okEnvelope(NotificationSchema)) },
    401: errorResponse('No valid session'),
    404: errorResponse('No such notification'),
    409: errorResponse('No active organization'),
  },
});

type NotificationAuditAction = 'notification.read' | 'notification.read_all';

function insertAudit(
  tx: Tx,
  tenant: Tenant,
  action: NotificationAuditAction,
  outcome: 'allowed' | 'not_found',
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  return tx.insert(auditEvent).values({
    organizationId: tenant.orgId,
    actorUserId: tenant.userId,
    entityType: 'notification',
    action,
    outcome,
    entityId,
    metadata,
  });
}

const mine = (tenant: Tenant) =>
  and(eq(notification.organizationId, tenant.orgId), eq(notification.userId, tenant.userId));

const unreadCountOf = async (tx: Tx, tenant: Tenant): Promise<number> => {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(notification)
    .where(and(mine(tenant), isNull(notification.readAt)));
  return row?.n ?? 0;
};

async function notificationNotFound(
  c: Context,
  db: Parameters<typeof withTenant>[0],
  tenant: Tenant,
  id: string,
  malformed: boolean,
) {
  await withTenant(db, tenant.orgId, (tx) =>
    insertAudit(
      tx,
      tenant,
      'notification.read',
      'not_found',
      malformed ? null : id,
      malformed ? { reason: 'malformed_id' } : {},
    ),
  );
  return fail(c, 404, 'not_found', 'Notification not found.');
}

export const notifications = new OpenAPIHono<AppEnv>()
  .openapi(listRoute, async (c) => {
    const { db, tenant } = c.var;
    const { limit } = c.req.valid('query');
    const result = await withTenant(db, tenant.orgId, async (tx) => {
      await materializeReminders(tx, tenant, new Date());
      const rows = await tx
        .select()
        .from(notification)
        .where(mine(tenant))
        .orderBy(desc(notification.createdAt), desc(notification.id))
        .limit(limit);
      return { rows, unreadCount: await unreadCountOf(tx, tenant) };
    });
    return ok(c, { items: result.rows.map(toJson), unreadCount: result.unreadCount }, 200);
  })
  .openapi(readAllRoute, async (c) => {
    const { db, tenant } = c.var;
    await withTenant(db, tenant.orgId, async (tx) => {
      await tx
        .update(notification)
        .set({ readAt: sql`clock_timestamp()` as unknown as Date })
        .where(and(mine(tenant), isNull(notification.readAt)));
      await insertAudit(tx, tenant, 'notification.read_all', 'allowed', null);
    });
    return ok(c, { unreadCount: 0 as const }, 200);
  })
  .openapi(readRoute, async (c) => {
    const { db, tenant } = c.var;
    const { id } = c.req.valid('param');
    if (!NOTIFICATION_ID_PATTERN.test(id)) {
      return notificationNotFound(c, db, tenant, id, true);
    }
    const row = await withTenant(db, tenant.orgId, async (tx) => {
      const [updated] = await tx
        .update(notification)
        .set({ readAt: sql`clock_timestamp()` as unknown as Date })
        .where(and(eq(notification.id, id), mine(tenant), isNull(notification.readAt)))
        .returning();
      // Already read keeps its original readAt.
      const [current] =
        updated !== undefined
          ? [updated]
          : await tx
              .select()
              .from(notification)
              .where(and(eq(notification.id, id), mine(tenant)))
              .limit(1);
      if (current) await insertAudit(tx, tenant, 'notification.read', 'allowed', id);
      return current;
    });
    if (!row) return notificationNotFound(c, db, tenant, id, false);
    return ok(c, toJson(row), 200);
  });

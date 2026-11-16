import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  DAILY_GOAL_DEFAULT,
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  normalizeWidgetOrder,
  TODAY_WIDGETS,
} from '@knoqra/core';
import { type Database, type Tx, userTodayPrefs, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../lib/context';
import { errorResponse, ok, okEnvelope } from '../lib/envelope';
import { insertUserAudit } from '../lib/user-audit';

const Widget = z.enum(TODAY_WIDGETS);

const TodayPrefsSchema = z
  .object({
    dailyGoal: z.number().int(),
    widgetOrder: z.array(Widget),
    hiddenWidgets: z.array(Widget),
  })
  .openapi('TodayPrefs');
export type TodayPrefsJson = z.infer<typeof TodayPrefsSchema>;

const UpdateTodayPrefsSchema = z
  .object({
    dailyGoal: z.number().int().min(DAILY_GOAL_MIN).max(DAILY_GOAL_MAX).optional(),
    widgetOrder: z
      .array(Widget)
      .refine(
        (order) => order.length === TODAY_WIDGETS.length && new Set(order).size === order.length,
        'Must list every widget exactly once',
      )
      .optional(),
    hiddenWidgets: z
      .array(Widget)
      .refine((hidden) => new Set(hidden).size === hidden.length, 'Must not repeat a widget')
      .optional(),
  })
  .openapi('UpdateTodayPrefs');

export const DEFAULT_TODAY_PREFS: TodayPrefsJson = {
  dailyGoal: DAILY_GOAL_DEFAULT,
  widgetOrder: [...TODAY_WIDGETS],
  hiddenWidgets: [],
};

/** The user's Today preferences, or the defaults when they have never saved any. */
export async function loadTodayPrefs(db: Database | Tx, userId: string): Promise<TodayPrefsJson> {
  const [row] = await db
    .select()
    .from(userTodayPrefs)
    .where(eq(userTodayPrefs.userId, userId))
    .limit(1);
  if (!row) return DEFAULT_TODAY_PREFS;
  return {
    dailyGoal: row.dailyGoal,
    widgetOrder: normalizeWidgetOrder(row.widgetOrder),
    hiddenWidgets: TODAY_WIDGETS.filter((w) => row.hiddenWidgets.includes(w)),
  };
}

const security = [{ session: [] }];

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/me/today-prefs',
  tags: ['account'],
  summary: "The signed-in user's Today preferences (defaults when none are saved)",
  security,
  responses: {
    200: {
      description: 'Today preferences',
      content: { 'application/json': { schema: okEnvelope(TodayPrefsSchema) } },
    },
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/me/today-prefs',
  tags: ['account'],
  summary: "Update the signed-in user's Today preferences (partial)",
  security,
  request: {
    body: { required: true, content: { 'application/json': { schema: UpdateTodayPrefsSchema } } },
  },
  responses: {
    200: {
      description: 'Updated Today preferences',
      content: { 'application/json': { schema: okEnvelope(TodayPrefsSchema) } },
    },
    400: errorResponse('Invalid goal, widget order or hidden widgets'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization the user belongs to'),
  },
});

export const todayPrefs = new OpenAPIHono<AppEnv>()
  .openapi(getRoute, async (c) => ok(c, await loadTodayPrefs(c.var.db, c.var.tenant.userId), 200))
  .openapi(patchRoute, async (c) => {
    const { db, tenant } = c.var;
    const body = c.req.valid('json');
    const changes = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    ) as typeof body;
    const fields = Object.keys(changes);
    if (fields.length === 0) return ok(c, await loadTodayPrefs(db, tenant.userId), 200);

    // The key is always the session user: nothing in the request can name another user.
    const saved = await withTenant(db, tenant.orgId, async (tx) => {
      await tx
        .insert(userTodayPrefs)
        .values({ userId: tenant.userId, ...changes })
        .onConflictDoUpdate({
          target: userTodayPrefs.userId,
          set: { ...changes, updatedAt: new Date() },
        });
      await insertUserAudit(tx, tenant, 'user.today_prefs.update', fields);
      return loadTodayPrefs(tx, tenant.userId);
    });
    return ok(c, saved, 200);
  });

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addDays,
  buildHeatmap,
  computeStreak,
  currentPermissions,
  dayKeyIn,
  isDayKey,
  startOfWeek,
  weekdayIndex,
} from '@knoqra/core';
import { contact, contactPermissionEvent, type Tx, task, withTenant } from '@knoqra/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AppEnv } from '../lib/context';
import { errorResponse, fail, ok, okEnvelope } from '../lib/envelope';
import {
  isPostgresInvalidZone,
  MAX_TIME_ZONE_LENGTH,
  parseTimeZoneQuery,
} from '../lib/time-zone-query';
import {
  type ActivityEntry,
  type ActivityScope,
  loadEntries,
  loadOutcomeCounts,
} from '../today/activity-sources';
import { loadTodayPrefs } from './today-prefs';

const COUNT_DAYS = 365;
const HEATMAP_WEEKS = 16;
const MAX_WEEK_ROWS = 8;
const MAX_START_LENGTH = 16;

const ActivityEntrySchema = z
  .object({
    at: z.iso.datetime(),
    day: z.string(),
    contactId: z.string().nullable(),
    kind: z.enum(['call', 'message', 'note', 'consent', 'task_due', 'task_done']),
    label: z.string(),
    refType: z.string(),
    refId: z.string(),
    outcome: z.boolean(),
  })
  .openapi('ActivityEntry');

const TodaySummarySchema = z
  .object({
    timeZone: z.string(),
    today: z.string(),
    streak: z.object({ current: z.number(), best: z.number(), todayKept: z.boolean() }),
    heatmap: z.array(
      z.object({
        days: z.array(
          z.object({
            day: z.string(),
            count: z.number(),
            level: z.number().int().min(0).max(4),
            state: z.enum(['past', 'today', 'upcoming']),
          }),
        ),
      }),
    ),
    goal: z.object({ target: z.number(), done: z.number() }),
    todayByKind: z.object({
      calls: z.number(),
      messages: z.number(),
      notes: z.number(),
      tasksDone: z.number(),
    }),
    dueToday: z.number(),
    overdue: z.number(),
  })
  .openapi('TodaySummary');

const WeekSchema = z
  .object({
    start: z.string(),
    days: z.array(z.string()),
    rows: z.array(
      z.object({
        contact: z.object({
          id: z.string(),
          displayName: z.string(),
          company: z.string().nullable(),
        }),
        blocked: z.boolean(),
        entries: z.array(ActivityEntrySchema),
      }),
    ),
  })
  .openapi('TodayWeek');

const TzQuery = z.object({ tz: z.string().max(MAX_TIME_ZONE_LENGTH).optional() });
const WeekQuery = TzQuery.extend({ start: z.string().max(MAX_START_LENGTH).optional() });

const security = [{ session: [] }];
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const summaryRoute = createRoute({
  method: 'get',
  path: '/api/v1/today',
  tags: ['today'],
  summary: 'Streak, heatmap, goal and due counts for today in the given time zone',
  security,
  request: { query: TzQuery },
  responses: {
    200: { description: 'Today summary', content: json(okEnvelope(TodaySummarySchema)) },
    400: errorResponse('Not an IANA time zone'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

const weekRoute = createRoute({
  method: 'get',
  path: '/api/v1/today/week',
  tags: ['today'],
  summary: 'The week grid: up to eight contacts with their activity, Monday to Sunday',
  security,
  request: { query: WeekQuery },
  responses: {
    200: { description: 'Week grid', content: json(okEnvelope(WeekSchema)) },
    400: errorResponse('Bad time zone, or a start that is not a Monday'),
    401: errorResponse('No valid session'),
    409: errorResponse('No active organization'),
  },
});

function toEntryJson(entry: ActivityEntry) {
  return { ...entry, at: entry.at.toISOString() };
}

function badZone(c: Context) {
  return fail(c, 400, 'validation_error', 'tz: Not an IANA time zone');
}

/**
 * `overdue`: open tasks of the user with due_at before now. `dueToday`: open tasks whose due day in
 * the user's zone is today and whose due_at is not yet past (so the two never overlap).
 */
async function dueCounts(tx: Tx, userId: string, timeZone: string, today: string) {
  const [row] = await tx
    .select({
      overdue: sql<number>`count(*) filter (where ${task.dueAt} < now())::int`,
      dueToday: sql<number>`count(*) filter (where ${task.dueAt} >= now() and (${task.dueAt} at time zone ${timeZone})::date = ${today}::date)::int`,
    })
    .from(task)
    .where(and(eq(task.ownerUserId, userId), eq(task.status, 'open')));
  return { overdue: row?.overdue ?? 0, dueToday: row?.dueToday ?? 0 };
}

export const today = new OpenAPIHono<AppEnv>()
  .openapi(summaryRoute, async (c) => {
    const { db, tenant } = c.var;
    const parsed = parseTimeZoneQuery(c.req.valid('query').tz);
    if (!parsed.ok) return badZone(c);
    const timeZone = parsed.value;
    const todayKey = dayKeyIn(new Date(), timeZone);
    const earliest = addDays(todayKey, -(COUNT_DAYS - 1));
    const scope: ActivityScope = { orgId: tenant.orgId, userId: tenant.userId, timeZone };

    try {
      const summary = await withTenant(db, tenant.orgId, async (tx) => {
        const counts = await loadOutcomeCounts(tx, scope, { from: earliest, to: todayKey });
        const entries = await loadEntries(tx, scope, { from: todayKey, to: todayKey });
        const prefs = await loadTodayPrefs(tx, tenant.userId);
        const due = await dueCounts(tx, tenant.userId, timeZone, todayKey);
        const outcomes = entries.filter((e) => e.outcome);
        const kinds = (kind: ActivityEntry['kind']) =>
          outcomes.filter((e) => e.kind === kind).length;
        return {
          timeZone,
          today: todayKey,
          streak: computeStreak(counts, todayKey, earliest),
          heatmap: buildHeatmap(counts, todayKey, HEATMAP_WEEKS),
          goal: { target: prefs.dailyGoal, done: counts.get(todayKey) ?? 0 },
          todayByKind: {
            calls: kinds('call'),
            messages: kinds('message'),
            notes: kinds('note'),
            tasksDone: kinds('task_done'),
          },
          dueToday: due.dueToday,
          overdue: due.overdue,
        };
      });
      return ok(c, summary, 200);
    } catch (error) {
      if (isPostgresInvalidZone(error)) return badZone(c);
      throw error;
    }
  })
  .openapi(weekRoute, async (c) => {
    const { db, tenant } = c.var;
    const query = c.req.valid('query');
    const parsed = parseTimeZoneQuery(query.tz);
    if (!parsed.ok) return badZone(c);
    const timeZone = parsed.value;
    const start = query.start ?? startOfWeek(dayKeyIn(new Date(), timeZone));
    if (!isDayKey(start) || weekdayIndex(start) !== 0) {
      return fail(c, 400, 'validation_error', 'start: Must be a Monday as YYYY-MM-DD');
    }
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const scope: ActivityScope = { orgId: tenant.orgId, userId: tenant.userId, timeZone };

    try {
      const rows = await withTenant(db, tenant.orgId, async (tx) => {
        const entries = await loadEntries(tx, scope, { from: start, to: addDays(start, 6) });
        const byContact = new Map<string, ActivityEntry[]>();
        for (const entry of entries) {
          if (!entry.contactId) continue;
          byContact.set(entry.contactId, [...(byContact.get(entry.contactId) ?? []), entry]);
        }
        if (byContact.size === 0) return [];
        // Archived or merged contacts leave the grid before the row cap is applied.
        const active = await tx
          .select({ id: contact.id, displayName: contact.displayName, company: contact.company })
          .from(contact)
          .where(
            and(
              inArray(contact.id, [...byContact.keys()]),
              isNull(contact.archivedAt),
              isNull(contact.mergedIntoId),
            ),
          );
        // Entries are sorted oldest first, so the latest entry of a contact is its last one.
        const latest = (id: string) => byContact.get(id)?.at(-1)?.at.getTime() ?? 0;
        const contacts = active.sort((x, y) => latest(y.id) - latest(x.id)).slice(0, MAX_WEEK_ROWS);
        const ids = contacts.map((ct) => ct.id);
        if (ids.length === 0) return [];
        const events = await tx
          .select({
            id: contactPermissionEvent.id,
            contactId: contactPermissionEvent.contactId,
            channel: contactPermissionEvent.channel,
            status: contactPermissionEvent.status,
            createdAt: contactPermissionEvent.createdAt,
          })
          .from(contactPermissionEvent)
          .where(inArray(contactPermissionEvent.contactId, ids))
          .orderBy(desc(contactPermissionEvent.createdAt), desc(contactPermissionEvent.id));

        return ids.flatMap((id) => {
          const found = contacts.find((ct) => ct.id === id);
          if (!found) return [];
          const permissions = currentPermissions(events.filter((e) => e.contactId === id));
          return [
            {
              contact: found,
              blocked: Object.values(permissions).includes('do_not_contact'),
              entries: (byContact.get(id) ?? []).map(toEntryJson),
            },
          ];
        });
      });
      return ok(c, { start, days, rows }, 200);
    } catch (error) {
      if (isPostgresInvalidZone(error)) return badZone(c);
      throw error;
    }
  });

import { auditEvent, task, withTenant } from '@knoqra/db';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { dedupeKeySql } from '../src/today/reminders';
import { api, get, post, signUp, signUpTeammate, uniqueEmail, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type TaskJson = { id: string };
type NotificationJson = {
  id: string;
  kind: 'task_due' | 'task_reminder' | 'system';
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  readAt: string | null;
  createdAt: string;
};
type Feed = { items: NotificationJson[]; unreadCount: number };

let cookieA: string;
let cookieB: string;
let orgB: string;

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const ahead = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${r.status} ${JSON.stringify(json.error)}`);
  return json.data;
}
function patch(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
const createTask = async (cookie: string, body: Record<string, unknown>) =>
  data<TaskJson>(await post('/api/v1/tasks', cookie, body));
const feed = async (cookie: string, query = '') =>
  data<Feed>(await get(`/api/v1/notifications${query}`, cookie));
const forTask = (f: Feed, taskId: string) => f.items.filter((n) => n.refId === taskId);

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  if (!body.data) throw new Error('no me');
  return body.data.organization.id;
}

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('nt-a'), 'Notify A');
  cookieB = await signUp(uniqueEmail('nt-b'), 'Notify B');
  orgB = await orgOf(cookieB);
});

describe('reminders made on read', () => {
  it('creates one task_reminder for a past remindAt, however often or concurrently it is read', async () => {
    const t = await createTask(cookieA, { title: 'Call the vet', remindAt: ago(2) });
    const first = await feed(cookieA);
    const mine = forTask(first, t.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'task_reminder',
      title: 'Reminder: Call the vet',
      refType: 'task',
      refId: t.id,
      readAt: null,
    });
    await feed(cookieA);
    const both = await Promise.all([feed(cookieA), feed(cookieA)]);
    for (const f of both) expect(forTask(f, t.id)).toHaveLength(1);
    expect(forTask(await feed(cookieA), t.id)).toHaveLength(1);
  });

  it('creates exactly one more when remindAt moves to another past time', async () => {
    const t = await createTask(cookieA, { title: 'Move me', remindAt: ago(5) });
    expect(forTask(await feed(cookieA), t.id)).toHaveLength(1);
    const r = await patch(`/api/v1/tasks/${t.id}`, cookieA, { remindAt: ago(3) });
    expect(r.status).toBe(200);
    expect(forTask(await feed(cookieA), t.id)).toHaveLength(2);
    expect(forTask(await feed(cookieA), t.id)).toHaveLength(2);
  });

  it('creates a task_due entry for an overdue task', async () => {
    const t = await createTask(cookieA, { title: 'Send invoice', dueAt: ago(1) });
    const mine = forTask(await feed(cookieA), t.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'task_due', title: 'Overdue: Send invoice' });
  });

  it('never notifies for a done task or a future remindAt', async () => {
    const done = await createTask(cookieA, { title: 'Already done', remindAt: ago(2) });
    await patch(`/api/v1/tasks/${done.id}`, cookieA, { status: 'done' });
    const future = await createTask(cookieA, {
      title: 'Later',
      remindAt: ahead(4),
      dueAt: ahead(5),
    });
    const f = await feed(cookieA);
    expect(forTask(f, done.id)).toHaveLength(0);
    expect(forTask(f, future.id)).toHaveLength(0);
  });

  it('builds the same dedupe keys in SQL as in JavaScript, so a poll skips existing ones', async () => {
    const stamps = [
      '2026-01-02T03:04:05.006Z',
      '2026-03-08T10:30:00.120Z',
      '2025-12-31T23:59:59.999Z',
    ];
    const orgA = await orgOf(cookieA);
    for (const at of stamps) {
      const t = await createTask(cookieA, { title: `Key ${at}`, remindAt: at, dueAt: at });
      const [row] = await withAppDb((db) =>
        withTenant(db, orgA, (tx) =>
          tx
            .select({
              reminder: dedupeKeySql('reminder', sql`${task.remindAt}`),
              due: dedupeKeySql('due', sql`${task.dueAt}`),
            })
            .from(task)
            .where(eq(task.id, t.id)),
        ),
      );
      const iso = new Date(at).toISOString();
      expect(row).toEqual({ reminder: `reminder:${t.id}:${iso}`, due: `due:${t.id}:${iso}` });
    }
    // One notification of each kind per task, however often it is polled.
    await feed(cookieA);
    const f = await feed(cookieA, '?limit=50');
    const keyed = f.items.filter((n) => n.title.includes('Key '));
    expect(keyed).toHaveLength(stamps.length * 2);
  });
});

describe('reading', () => {
  it('lists newest first, honours limit and validates it', async () => {
    await createTask(cookieA, { title: 'Order check', remindAt: ago(1) });
    const f = await feed(cookieA);
    const times = f.items.map((n) => n.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect((await feed(cookieA, '?limit=1')).items).toHaveLength(1);
    expect((await get('/api/v1/notifications?limit=51', cookieA)).status).toBe(400);
  });

  it('drops unreadCount by one per read, keeps readAt idempotent, and read-all zeroes it', async () => {
    const a = await createTask(cookieA, { title: 'Read one', remindAt: ago(2) });
    await createTask(cookieA, { title: 'Read two', remindAt: ago(2) });
    const before = await feed(cookieA);
    expect(before.unreadCount).toBeGreaterThanOrEqual(2);
    const target = forTask(before, a.id)[0];
    if (!target) throw new Error('missing notification');
    const r1 = await post(`/api/v1/notifications/${target.id}/read`, cookieA, {});
    expect(r1.status).toBe(200);
    const read = await data<NotificationJson>(r1);
    expect(read.readAt).not.toBeNull();
    const mid = await feed(cookieA);
    expect(mid.unreadCount).toBe(before.unreadCount - 1);
    const again = await data<NotificationJson>(
      await post(`/api/v1/notifications/${target.id}/read`, cookieA, {}),
    );
    expect(again.readAt).toBe(read.readAt);
    const all = await post('/api/v1/notifications/read-all', cookieA, {});
    expect(all.status).toBe(200);
    expect(await data<{ unreadCount: number }>(all)).toEqual({ unreadCount: 0 });
    expect((await feed(cookieA)).unreadCount).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('404s with a not_found audit when another org reads a notification id', async () => {
    const t = await createTask(cookieA, { title: 'Private', remindAt: ago(2) });
    const n = forTask(await feed(cookieA), t.id)[0];
    if (!n) throw new Error('missing notification');
    const audits = () =>
      withAppDb((db) => withTenant(db, orgB, (tx) => tx.select().from(auditEvent)));
    const before = (await audits()).length;
    const r = await post(`/api/v1/notifications/${n.id}/read`, cookieB, {});
    const bad = await post('/api/v1/notifications/not-an-id/read', cookieB, {});
    for (const res of [r, bad]) {
      expect(res.status).toBe(404);
      expect(((await res.json()) as Envelope<never>).error?.code).toBe('not_found');
    }
    const after = (await audits()).slice(before);
    expect(after).toHaveLength(2);
    expect(
      after.every(
        (a) =>
          a.outcome === 'not_found' && a.organizationId === orgB && a.entityType === 'notification',
      ),
    ).toBe(true);
    const mine = forTask(await feed(cookieA), t.id)[0];
    expect(mine?.readAt).toBeNull();
    expect((await feed(cookieB)).items).toHaveLength(0);
  });
});

describe('same organization, another member', () => {
  it("404s with a not_found audit when a teammate reads someone else's notification", async () => {
    const owner = await signUp(uniqueEmail('nt-own'), 'Notify Owner');
    const orgId = await orgOf(owner);
    const mate = await signUpTeammate(orgId);
    const t = await createTask(owner, { title: 'Owner only', remindAt: ago(2) });
    const n = forTask(await feed(owner), t.id)[0];
    if (!n) throw new Error('missing notification');
    const audits = () =>
      withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));
    const before = (await audits()).length;
    const r = await post(`/api/v1/notifications/${n.id}/read`, mate.cookie, {});
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<never>).error?.code).toBe('not_found');
    const after = (await audits()).slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      entityType: 'notification',
      outcome: 'not_found',
      entityId: n.id,
      actorUserId: mate.userId,
    });
    // Read-all and the feed stay the teammate's own.
    expect((await post('/api/v1/notifications/read-all', mate.cookie, {})).status).toBe(200);
    expect(forTask(await feed(mate.cookie), t.id)).toHaveLength(0);
    const mine = forTask(await feed(owner), t.id)[0];
    expect(mine?.readAt).toBeNull();
  });
});

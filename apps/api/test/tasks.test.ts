import { newId } from '@knoqra/core';
import { auditEvent, notification, task, withTenant } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  get,
  post,
  signUp,
  signUpTeammate,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type TaskJson = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  remindAt: string | null;
  status: 'open' | 'done';
  completedAt: string | null;
  contact: { id: string; displayName: string } | null;
  createdAt: string;
  updatedAt: string;
};
type Page = { items: TaskJson[]; nextCursor: string | null };
type TimelinePage = {
  items: { kind: string; title: string; refType: string | null; refId: string | null }[];
};

let cookieA: string;
let cookieB: string;
let orgA: string;
let userA: string;
let orgB: string;
let seq = 0;

async function meOf(cookie: string): Promise<{ orgId: string; userId: string }> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!body.data) throw new Error('no me');
  return { orgId: body.data.organization.id, userId: body.data.user.id };
}

async function newContact(cookie: string): Promise<string> {
  seq += 1;
  const r = await post('/api/v1/contacts', cookie, {
    displayName: `Task Contact ${seq}`,
    phone: `+1202556${String(1000 + seq).padStart(4, '0')}`,
  });
  const json = (await r.json()) as Envelope<{ id: string }>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data.id;
}

function patch(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
function del(path: string, cookie: string): Promise<Response> {
  return api(path, { method: 'DELETE', headers: { cookie } });
}
async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${r.status} ${JSON.stringify(json.error)}`);
  return json.data;
}
const create = async (cookie: string, body: Record<string, unknown>) =>
  data<TaskJson>(await post('/api/v1/tasks', cookie, body));
const timeline = async (cookie: string, id: string) =>
  data<TimelinePage>(await get(`/api/v1/contacts/${id}/timeline`, cookie));
const audits = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));
const b64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('tk-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('tk-b'), 'Owner B');
  ({ orgId: orgA, userId: userA } = await meOf(cookieA));
  ({ orgId: orgB } = await meOf(cookieB));
});

describe('POST /tasks', () => {
  it('creates a task without a contact', async () => {
    const t = await create(cookieA, { title: '  Call the bank  ', notes: 'ask about fees' });
    expect(t).toMatchObject({
      title: 'Call the bank',
      notes: 'ask about fees',
      dueAt: null,
      remindAt: null,
      status: 'open',
      completedAt: null,
      contact: null,
    });
    expect(t.id).toMatch(/^tk_[0-9a-f]{32}$/);
  });

  it('creates a task with a contact and writes a timeline entry', async () => {
    const contactId = await newContact(cookieA);
    const t = await create(cookieA, {
      title: 'Send quote',
      dueAt: '2030-01-02T10:00:00+02:00',
      remindAt: '2030-01-02T07:00:00Z',
      contactId,
    });
    expect(t.contact?.id).toBe(contactId);
    expect(t.dueAt).toBe('2030-01-02T08:00:00.000Z');
    const events = (await timeline(cookieA, contactId)).items.filter((e) => e.kind === 'task');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Task added: Send quote',
      refType: 'task',
      refId: t.id,
    });
  });

  it('rejects bad input with 400 validation_error', async () => {
    for (const body of [
      { title: '' },
      { title: 'bad\u0000title' },
      { title: 'x', dueAt: 'tomorrow' },
      { title: 'x', remindAt: '2030-01-02' },
    ]) {
      const r = await post('/api/v1/tasks', cookieA, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
    }
  });

  it('404s for a malformed contact id without reaching SQL, audited with no entity id', async () => {
    const before = (await audits(orgA)).length;
    for (const contactId of ['\u0000', 'ct_\u0000', 'garbage', 'ct_NOTHEX']) {
      const r = await post('/api/v1/tasks', cookieA, { title: 'x', contactId });
      expect(r.status).toBe(404);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('not_found');
    }
    const after = (await audits(orgA)).slice(before);
    expect(after).toHaveLength(4);
    for (const a of after) {
      expect(a).toMatchObject({ entityType: 'contact', outcome: 'not_found', entityId: null });
      expect(a.metadata).toEqual({ reason: 'malformed_id' });
    }
  });

  it('404s for a missing or foreign contact and 422s for an archived one', async () => {
    const foreign = await newContact(cookieB);
    for (const contactId of [foreign, newId('ct'), 'nope']) {
      const r = await post('/api/v1/tasks', cookieA, { title: 'x', contactId });
      expect(r.status).toBe(404);
    }
    const archived = await newContact(cookieA);
    await post(`/api/v1/contacts/${archived}/archive`, cookieA, {});
    const r = await post('/api/v1/tasks', cookieA, { title: 'x', contactId: archived });
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
  });
});

describe('GET /tasks', () => {
  it('pages 120 open tasks in due order, undated last, without gaps or duplicates', async () => {
    const owner = await signUp(uniqueEmail('tk-page'), 'Pager');
    const me = await meOf(owner);
    const base = Date.parse('2031-01-01T00:00:00Z');
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: newId('tk'),
      organizationId: me.orgId,
      ownerUserId: me.userId,
      title: `T${i}`,
      // every 4th is undated; the others share due dates in pairs so created_at/id break ties
      dueAt: i % 4 === 0 ? null : new Date(base + Math.floor(i / 2) * 3_600_000),
      createdAt: new Date(base - (120 - i) * 1000),
    }));
    await withAdminDb((db) => db.insert(task).values(rows));
    const expected = [...rows]
      .sort((a, b) => {
        const da = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
        const dbb = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return (
          da - dbb || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
        );
      })
      .map((r) => r.id);

    const sizes: number[] = [];
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 6; guard += 1) {
      const qs: string = `?status=open&limit=50${cursor ? `&cursor=${cursor}` : ''}`;
      const page: Page = await data<Page>(await get(`/api/v1/tasks${qs}`, owner));
      sizes.push(page.items.length);
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(120);
  });

  it('lists done tasks newest completion first and filters by contact', async () => {
    const owner = await signUp(uniqueEmail('tk-done'), 'Doner');
    const contactId = await newContact(owner);
    const a = await create(owner, { title: 'A', contactId });
    const b = await create(owner, { title: 'B' });
    await patch(`/api/v1/tasks/${a.id}`, owner, { status: 'done' });
    await patch(`/api/v1/tasks/${b.id}`, owner, { status: 'done' });
    const done = await data<Page>(await get('/api/v1/tasks?status=done', owner));
    expect(done.items.map((t) => t.title)).toEqual(['B', 'A']);
    const byContact = await data<Page>(await get(`/api/v1/tasks?contactId=${contactId}`, owner));
    expect(byContact.items).toHaveLength(0);
    const doneByContact = await data<Page>(
      await get(`/api/v1/tasks?status=done&contactId=${contactId}`, owner),
    );
    expect(doneByContact.items.map((t) => t.title)).toEqual(['A']);
    const first = await data<Page>(await get('/api/v1/tasks?status=done&limit=1', owner));
    expect(first.nextCursor).not.toBeNull();
    const second = await data<Page>(
      await get(`/api/v1/tasks?status=done&limit=1&cursor=${first.nextCursor}`, owner),
    );
    expect(second.items.map((t) => t.title)).toEqual(['A']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a cursor from the other status or a malformed cursor with 400', async () => {
    const owner = await signUp(uniqueEmail('tk-cur'), 'Cur');
    await create(owner, { title: 'one' });
    await create(owner, { title: 'two' });
    const open = await data<Page>(await get('/api/v1/tasks?status=open&limit=1', owner));
    expect(open.nextCursor).not.toBeNull();
    const wrong = await get(`/api/v1/tasks?status=done&cursor=${open.nextCursor}`, owner);
    expect(wrong.status).toBe(400);
    const t = await create(owner, { title: 'three' });
    await patch(`/api/v1/tasks/${t.id}`, owner, { status: 'done' });
    const t2 = await create(owner, { title: 'four' });
    await patch(`/api/v1/tasks/${t2.id}`, owner, { status: 'done' });
    const done = await data<Page>(await get('/api/v1/tasks?status=done&limit=1', owner));
    const wrong2 = await get(`/api/v1/tasks?status=open&cursor=${done.nextCursor}`, owner);
    expect(wrong2.status).toBe(400);
    expect(((await wrong2.json()) as Envelope<never>).error?.code).toBe('validation_error');
    for (const cursor of ['%%%', b64url('not json'), b64url('{"s":"open"}')]) {
      expect((await get(`/api/v1/tasks?status=open&cursor=${cursor}`, owner)).status).toBe(400);
    }
  });

  it('rejects a malformed contactId filter with 400 validation_error', async () => {
    for (const contactId of ['%00', 'garbage', 'ct_%00']) {
      const r = await get(`/api/v1/tasks?contactId=${contactId}`, cookieA);
      expect(r.status).toBe(400);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
    }
  });

  it('shows only the caller own tasks', async () => {
    const mine = await create(cookieA, { title: 'Private to A' });
    const list = await data<Page>(await get('/api/v1/tasks?limit=200', cookieB));
    expect(list.items.some((t) => t.id === mine.id)).toBe(false);
  });
});

describe('PATCH /tasks/{id}', () => {
  it('completes and reopens, with timeline entry and audit', async () => {
    const contactId = await newContact(cookieA);
    const t = await create(cookieA, {
      title: 'Follow up',
      contactId,
      dueAt: '2030-05-05T09:00:00Z',
    });
    const done = await data<TaskJson>(
      await patch(`/api/v1/tasks/${t.id}`, cookieA, { status: 'done' }),
    );
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();
    const titles = (await timeline(cookieA, contactId)).items.map((e) => e.title);
    expect(titles).toContain('Task done: Follow up');

    const reopened = await data<TaskJson>(
      await patch(`/api/v1/tasks/${t.id}`, cookieA, { status: 'open' }),
    );
    expect(reopened.status).toBe('open');
    expect(reopened.completedAt).toBeNull();

    const updated = await data<TaskJson>(
      await patch(`/api/v1/tasks/${t.id}`, cookieA, {
        title: 'Follow up again',
        notes: null,
        dueAt: null,
      }),
    );
    expect(updated).toMatchObject({ title: 'Follow up again', notes: null, dueAt: null });

    const mine = (await audits(orgA)).filter((a) => a.entityType === 'task' && a.entityId === t.id);
    expect(mine.map((a) => a.action)).toEqual(
      expect.arrayContaining(['task.create', 'task.complete', 'task.reopen', 'task.update']),
    );
    expect(JSON.stringify(mine.map((a) => a.metadata))).not.toContain('Follow up');
  });

  it('rejects an empty patch and bad values with 400', async () => {
    const t = await create(cookieA, { title: 'x' });
    for (const body of [{}, { title: '' }, { status: 'later' }, { dueAt: 'soon' }]) {
      expect((await patch(`/api/v1/tasks/${t.id}`, cookieA, body)).status).toBe(400);
    }
  });
});

describe('DELETE /tasks/{id}', () => {
  it('deletes with 204 and audits', async () => {
    const t = await create(cookieA, { title: 'Temp' });
    const r = await del(`/api/v1/tasks/${t.id}`, cookieA);
    expect(r.status).toBe(204);
    expect((await del(`/api/v1/tasks/${t.id}`, cookieA)).status).toBe(404);
    const row = await withAdminDb((db) => db.select().from(task).where(eq(task.id, t.id)));
    expect(row).toHaveLength(0);
    const log = await audits(orgA);
    expect(log.some((a) => a.action === 'task.delete' && a.entityId === t.id)).toBe(true);
  });
});

describe('tenant isolation', () => {
  it('404s with a not_found audit for another org task and leaves it unchanged', async () => {
    const t = await create(cookieA, { title: 'Keep me', notes: 'secret' });
    const before = (await audits(orgB)).length;
    const calls = [
      await patch(`/api/v1/tasks/${t.id}`, cookieB, { title: 'Hijacked', status: 'done' }),
      await del(`/api/v1/tasks/${t.id}`, cookieB),
      await patch('/api/v1/tasks/not-an-id', cookieB, { title: 'x' }),
      await del('/api/v1/tasks/not-an-id', cookieB),
    ];
    for (const r of calls) {
      expect(r.status).toBe(404);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('not_found');
    }
    const after = (await audits(orgB)).slice(before);
    expect(after).toHaveLength(4);
    expect(
      after.every(
        (a) => a.outcome === 'not_found' && a.organizationId === orgB && a.entityType === 'task',
      ),
    ).toBe(true);
    const [row] = await withAdminDb((db) => db.select().from(task).where(eq(task.id, t.id)));
    expect(row).toMatchObject({
      title: 'Keep me',
      notes: 'secret',
      status: 'open',
      completedAt: null,
    });
    expect(row?.ownerUserId).toBe(userA);
  });
});

describe('reminders of finished tasks', () => {
  const HOUR = 3_600_000;
  const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
  type Feed = { items: { refId: string | null; readAt: string | null }[]; unreadCount: number };
  const feed = async (cookie: string) => data<Feed>(await get('/api/v1/notifications', cookie));

  it('completing a task marks its unread reminders read', async () => {
    const owner = await signUp(uniqueEmail('tk-clear'), 'Clearer');
    const t = await create(owner, { title: 'Ring back', remindAt: ago(3), dueAt: ago(2) });
    const other = await create(owner, { title: 'Still open', remindAt: ago(3) });
    const before = await feed(owner);
    expect(before.items.filter((n) => n.refId === t.id)).toHaveLength(2);
    expect(before.unreadCount).toBe(3);
    expect((await patch(`/api/v1/tasks/${t.id}`, owner, { status: 'done' })).status).toBe(200);
    const after = await feed(owner);
    expect(after.unreadCount).toBe(1);
    expect(after.items.filter((n) => n.refId === t.id).every((n) => n.readAt !== null)).toBe(true);
    expect(after.items.find((n) => n.refId === other.id)?.readAt).toBeNull();
  });

  it('deleting a task marks its unread reminders read', async () => {
    const owner = await signUp(uniqueEmail('tk-clear-del'), 'Deleter');
    const t = await create(owner, { title: 'Drop me', remindAt: ago(1) });
    expect((await feed(owner)).unreadCount).toBe(1);
    expect((await del(`/api/v1/tasks/${t.id}`, owner)).status).toBe(204);
    expect((await feed(owner)).unreadCount).toBe(0);
  });

  it("leaves a teammate's notifications alone", async () => {
    const owner = await signUp(uniqueEmail('tk-clear-own'), 'Owner');
    const { orgId } = await meOf(owner);
    const mate = await signUpTeammate(orgId);
    const t = await create(owner, { title: 'Mine', remindAt: ago(1) });
    await feed(owner);
    // A notification of the teammate's that happens to point at the same task.
    await withAdminDb((db) =>
      db.insert(notification).values({
        organizationId: orgId,
        userId: mate.userId,
        kind: 'system',
        title: 'Heads up',
        refType: 'task',
        refId: t.id,
        dedupeKey: `test:${t.id}`,
      }),
    );
    await patch(`/api/v1/tasks/${t.id}`, owner, { status: 'done' });
    const [row] = await withAdminDb((db) =>
      db
        .select()
        .from(notification)
        .where(and(eq(notification.userId, mate.userId), eq(notification.refId, t.id))),
    );
    expect(row?.readAt).toBeNull();
  });
});

describe('same organization, another member', () => {
  it("404s on a teammate's task and leaves it unchanged", async () => {
    const mate = await signUpTeammate(orgA);
    const t = await create(cookieA, { title: 'Owned by A', notes: 'only mine' });
    const before = (await audits(orgA)).length;
    const calls = [
      await patch(`/api/v1/tasks/${t.id}`, mate.cookie, { title: 'Taken', status: 'done' }),
      await del(`/api/v1/tasks/${t.id}`, mate.cookie),
    ];
    for (const r of calls) {
      expect(r.status).toBe(404);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('not_found');
    }
    const after = (await audits(orgA)).slice(before);
    expect(after).toHaveLength(2);
    for (const a of after) {
      expect(a).toMatchObject({
        entityType: 'task',
        outcome: 'not_found',
        entityId: t.id,
        actorUserId: mate.userId,
      });
    }
    const list = await data<Page>(await get('/api/v1/tasks?limit=200', mate.cookie));
    expect(list.items.some((x) => x.id === t.id)).toBe(false);
    const [row] = await withAdminDb((db) => db.select().from(task).where(eq(task.id, t.id)));
    expect(row).toMatchObject({ title: 'Owned by A', notes: 'only mine', status: 'open' });
    expect(row?.ownerUserId).toBe(userA);
  });
});

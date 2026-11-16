import { addDays, computeStreak, dayKeyIn, isWorkingDay } from '@knoqra/core';
import { timelineEvent } from '@knoqra/db';
import { describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Summary = {
  timeZone: string;
  today: string;
  streak: { current: number; best: number; todayKept: boolean };
  heatmap: { days: { day: string; count: number }[] }[];
  goal: { target: number; done: number };
  todayByKind: { calls: number; messages: number; notes: number; tasksDone: number };
  dueToday: number;
  overdue: number;
};
type Entry = { at: string; day: string; kind: string; label: string; outcome: boolean };
type Week = {
  start: string;
  days: string[];
  rows: {
    contact: { id: string; displayName: string; company: string | null };
    blocked: boolean;
    entries: Entry[];
  }[];
};
type TodayPrefs = { dailyGoal: number; widgetOrder: string[]; hiddenWidgets: string[] };

let seq = 0;

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${r.status} ${JSON.stringify(json.error)}`);
  return json.data;
}
function send(method: 'PUT' | 'PATCH', path: string, cookie: string, body: unknown) {
  return api(path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
async function me(cookie: string) {
  const d = await data<{ user: { id: string }; organization: { id: string } }>(
    await get('/api/v1/me', cookie),
  );
  return { userId: d.user.id, orgId: d.organization.id };
}
async function newContact(cookie: string, extra: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const r = await post('/api/v1/contacts', cookie, {
    displayName: `Today Contact ${seq}`,
    phone: `+1202557${String(1000 + seq).padStart(4, '0')}`,
    ...extra,
  });
  return (await data<{ id: string }>(r)).id;
}
const summary = async (cookie: string, query = '') =>
  data<Summary>(await get(`/api/v1/today${query}`, cookie));
const week = async (cookie: string, query: string) =>
  data<Week>(await get(`/api/v1/today/week${query}`, cookie));

async function insertNote(orgId: string, userId: string | null, contactId: string, at: string) {
  await withAdminDb((db) =>
    db.insert(timelineEvent).values({
      organizationId: orgId,
      contactId,
      kind: 'note',
      title: 'Note added',
      actorUserId: userId,
      occurredAt: new Date(at),
    }),
  );
}

describe('GET /today', () => {
  it('is empty for a fresh user', async () => {
    const cookie = await signUp(uniqueEmail('td-fresh'));
    const s = await summary(cookie);
    expect(s.timeZone).toBe('UTC');
    expect(s.streak).toEqual({ current: 0, best: 0, todayKept: false });
    expect(s.goal).toEqual({ target: 6, done: 0 });
    expect(s.todayByKind).toEqual({ calls: 0, messages: 0, notes: 0, tasksDone: 0 });
    expect(s.heatmap).toHaveLength(16);
    expect(s.heatmap.every((w) => w.days.length === 7)).toBe(true);
    expect(s.dueToday + s.overdue).toBe(0);
  });

  it('counts a note and a completed task, but not a consent change', async () => {
    const cookie = await signUp(uniqueEmail('td-count'));
    const contactId = await newContact(cookie);
    const note = await post(`/api/v1/contacts/${contactId}/notes`, cookie, { body: 'hi' });
    expect(note.status).toBe(201);
    const task = await data<{ id: string }>(await post('/api/v1/tasks', cookie, { title: 'T' }));
    const done = await send('PATCH', `/api/v1/tasks/${task.id}`, cookie, { status: 'done' });
    expect(done.status).toBe(200);
    await send('PUT', `/api/v1/contacts/${contactId}/permissions/sms`, cookie, {
      status: 'granted',
    });
    const s = await summary(cookie);
    expect(s.goal.done).toBe(2);
    expect(s.todayByKind).toEqual({ calls: 0, messages: 0, notes: 1, tasksDone: 1 });
  });

  it('derives the streak from the previous working days', async () => {
    const cookie = await signUp(uniqueEmail('td-streak'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie);
    const today = dayKeyIn(new Date(), 'UTC');
    const counts = new Map<string, number>();
    let cursor = addDays(today, -1);
    while (counts.size < 3) {
      if (isWorkingDay(cursor)) {
        counts.set(cursor, 1);
        await insertNote(orgId, userId, contactId, `${cursor}T12:00:00Z`);
      }
      cursor = addDays(cursor, -1);
    }
    const expected = computeStreak(counts, today, addDays(today, -364));
    const s = await summary(cookie);
    expect(s.streak).toEqual(expected);
    expect(s.streak.current).toBeGreaterThanOrEqual(3);
  });

  it("does not count another user's notes in the same organisation", async () => {
    const cookie = await signUp(uniqueEmail('td-own'));
    const { orgId } = await me(cookie);
    const other = await signUp(uniqueEmail('td-other'));
    const { userId: otherId } = await me(other);
    const contactId = await newContact(cookie);
    await insertNote(orgId, otherId, contactId, new Date().toISOString());
    await insertNote(orgId, null, contactId, new Date().toISOString());
    const s = await summary(cookie);
    expect(s.goal.done).toBe(0);
    expect(s.todayByKind.notes).toBe(0);
    expect(s.streak.current).toBe(0);
  });

  it('rejects an unknown time zone with 400', async () => {
    const cookie = await signUp(uniqueEmail('td-tz'));
    for (const tz of ['Mars/Base', '+05:00']) {
      const r = await get(`/api/v1/today?tz=${encodeURIComponent(tz)}`, cookie);
      expect(r.status).toBe(400);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
    }
    expect((await get('/api/v1/today/week?tz=Mars/Base', cookie)).status).toBe(400);
    expect((await summary(cookie, '?tz=Asia/Kolkata')).timeZone).toBe('Asia/Kolkata');
  });

  it('answers a legacy zone alias under its current name, even with activity', async () => {
    const cookie = await signUp(uniqueEmail('td-alias'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie);
    await insertNote(orgId, userId, contactId, new Date().toISOString());
    const r = await get('/api/v1/today?tz=Asia%2FCalcutta', cookie);
    expect(r.status).toBe(200);
    const s = await data<Summary>(r);
    expect(s.timeZone).toBe('Asia/Kolkata');
    expect(s.goal.done).toBe(1);
    const w = await get('/api/v1/today/week?tz=Asia%2FCalcutta', cookie);
    expect(w.status).toBe(200);
    expect((await data<Week>(w)).rows).toHaveLength(1);
  });

  it('counts open tasks as overdue or due later today', async () => {
    const cookie = await signUp(uniqueEmail('td-due'));
    const now = Date.now();
    const mk = (title: string, dueAt: number) =>
      post('/api/v1/tasks', cookie, { title, dueAt: new Date(dueAt).toISOString() });
    await mk('past', now - 3_600_000);
    await mk('past2', now - 86_400_000);
    expect((await summary(cookie)).overdue).toBe(2);
    expect((await mk('soon', now + 60_000)).status).toBe(201);
    const s = await summary(cookie);
    const sameDay = dayKeyIn(new Date(now + 60_000), 'UTC') === s.today;
    expect(s.dueToday).toBe(sameDay ? 1 : 0);
    expect(s.overdue).toBe(2);
  });
});

describe('GET /today/week', () => {
  it('shows one row per contact with notes and due tasks', async () => {
    const cookie = await signUp(uniqueEmail('wk-rows'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie, { company: 'Acme' });
    await newContact(cookie);
    await insertNote(orgId, userId, contactId, '2026-11-10T10:00:00Z');
    const t = await post('/api/v1/tasks', cookie, {
      title: 'Send quote',
      dueAt: '2026-11-11T09:30:00Z',
      contactId,
    });
    expect(t.status).toBe(201);
    await post('/api/v1/tasks', cookie, { title: 'No contact', dueAt: '2026-11-11T09:30:00Z' });
    const w = await week(cookie, '?start=2026-11-09');
    expect(w.start).toBe('2026-11-09');
    expect(w.days).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    expect(w.rows).toHaveLength(1);
    const row = w.rows[0];
    expect(row?.contact).toMatchObject({ id: contactId, company: 'Acme' });
    expect(row?.blocked).toBe(false);
    expect(row?.entries.map((e) => [e.kind, e.label, e.outcome, e.day])).toEqual([
      ['note', 'Note', true, '2026-11-10'],
      ['task_due', 'Due 09:30 · Send quote', false, '2026-11-11'],
    ]);
  });

  it('buckets days in the requested time zone', async () => {
    const cookie = await signUp(uniqueEmail('wk-tz'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie);
    await insertNote(orgId, userId, contactId, '2026-11-12T03:00:00Z');
    const la = await week(cookie, '?start=2026-11-09&tz=America/Los_Angeles');
    expect(la.rows[0]?.entries[0]?.day).toBe('2026-11-11');
    const kolkata = await week(cookie, '?start=2026-11-09&tz=Asia/Kolkata');
    expect(kolkata.rows[0]?.entries[0]?.day).toBe('2026-11-12');
  });

  it('flags do-not-contact contacts and rejects a start that is not a Monday', async () => {
    const cookie = await signUp(uniqueEmail('wk-dnc'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie);
    await insertNote(orgId, userId, contactId, '2026-11-10T10:00:00Z');
    await send('PUT', `/api/v1/contacts/${contactId}/permissions/sms`, cookie, {
      status: 'do_not_contact',
    });
    expect((await week(cookie, '?start=2026-11-09')).rows[0]?.blocked).toBe(true);
    for (const start of ['2026-11-10', 'nonsense']) {
      const r = await get(`/api/v1/today/week?start=${start}`, cookie);
      expect(r.status).toBe(400);
    }
    expect((await week(cookie, '')).days).toHaveLength(7);
  });

  it("shows other actors' and inbound events as entries that are not outcomes", async () => {
    const cookie = await signUp(uniqueEmail('wk-actors'));
    const { orgId, userId } = await me(cookie);
    const { userId: otherId } = await me(await signUp(uniqueEmail('wk-actors-b')));
    const contactId = await newContact(cookie);
    await insertNote(orgId, userId, contactId, '2026-11-10T08:00:00Z');
    await insertNote(orgId, otherId, contactId, '2026-11-10T09:00:00Z');
    await insertNote(orgId, null, contactId, '2026-11-10T10:00:00Z');
    const w = await week(cookie, '?start=2026-11-09');
    expect(w.rows[0]?.entries.map((e) => e.outcome)).toEqual([true, false, false]);
  });

  it('leaves archived contacts out and does not let them use up a row', async () => {
    const cookie = await signUp(uniqueEmail('wk-arch'));
    const { orgId, userId } = await me(cookie);
    const gone = await newContact(cookie);
    const kept = await newContact(cookie);
    await insertNote(orgId, userId, gone, '2026-11-10T12:00:00Z');
    await insertNote(orgId, userId, kept, '2026-11-10T08:00:00Z');
    expect((await post(`/api/v1/contacts/${gone}/archive`, cookie, {})).status).toBe(200);
    const w = await week(cookie, '?start=2026-11-09');
    expect(w.rows.map((r) => r.contact.id)).toEqual([kept]);
  });

  it('buckets an event on the DST change day by the local date', async () => {
    const cookie = await signUp(uniqueEmail('wk-dst'));
    const { orgId, userId } = await me(cookie);
    const contactId = await newContact(cookie);
    await insertNote(orgId, userId, contactId, '2026-11-01T08:30:00Z');
    await insertNote(orgId, userId, contactId, '2026-11-02T07:59:00Z');
    const w = await week(cookie, '?start=2026-10-26&tz=America/Los_Angeles');
    expect(w.rows[0]?.entries.map((e) => e.day)).toEqual(['2026-11-01', '2026-11-01']);
  });

  it('keeps at most 8 rows, latest activity first', async () => {
    const cookie = await signUp(uniqueEmail('wk-cap'));
    const { orgId, userId } = await me(cookie);
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await newContact(cookie);
      ids.push(id);
      await insertNote(orgId, userId, id, `2026-11-10T${String(8 + i).padStart(2, '0')}:00:00Z`);
    }
    const w = await week(cookie, '?start=2026-11-09');
    expect(w.rows.map((r) => r.contact.id)).toEqual(ids.slice(2).reverse());
  });
});

describe('GET/PATCH /me/today-prefs', () => {
  it('returns defaults, persists a PATCH, and rejects bad input', async () => {
    const cookie = await signUp(uniqueEmail('tp'));
    expect(await data<TodayPrefs>(await get('/api/v1/me/today-prefs', cookie))).toEqual({
      dailyGoal: 6,
      widgetOrder: ['streak', 'next', 'focus', 'otto'],
      hiddenWidgets: [],
    });
    const r = await send('PATCH', '/api/v1/me/today-prefs', cookie, {
      dailyGoal: 9,
      widgetOrder: ['otto', 'focus', 'next', 'streak'],
      hiddenWidgets: ['next'],
    });
    expect(r.status).toBe(200);
    const expected = {
      dailyGoal: 9,
      widgetOrder: ['otto', 'focus', 'next', 'streak'],
      hiddenWidgets: ['next'],
    };
    expect(await data<TodayPrefs>(await get('/api/v1/me/today-prefs', cookie))).toEqual(expected);
    expect((await summary(cookie)).goal.target).toBe(9);
    await send('PATCH', '/api/v1/me/today-prefs', cookie, { dailyGoal: 3 });
    const after = await data<TodayPrefs>(await get('/api/v1/me/today-prefs', cookie));
    expect(after).toEqual({ ...expected, dailyGoal: 3 });
    for (const body of [
      { dailyGoal: 13 },
      { dailyGoal: 0 },
      { widgetOrder: ['otto'] },
      { widgetOrder: ['streak', 'streak', 'focus', 'otto'] },
      { hiddenWidgets: ['next', 'next'] },
      { hiddenWidgets: ['bogus'] },
    ]) {
      expect((await send('PATCH', '/api/v1/me/today-prefs', cookie, body)).status).toBe(400);
    }
  });
});

import { newId } from '@knoqra/core';
import {
  auditEvent,
  contact,
  contactDuplicateDismissal,
  contactPermissionEvent,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type ContactJson = {
  id: string;
  displayName: string;
  company: string | null;
  email: string | null;
  jobTitle: string | null;
  timezone: string | null;
  tags: string[];
  archivedAt: string | null;
  mergedIntoId: string | null;
};
type Suggestion = { contact: ContactJson; reasons: string[] };
type Page = { items: ContactJson[]; nextCursor: string | null };
type TimelineItem = {
  kind: string;
  title: string;
  body: string | null;
  refType: string | null;
  refId: string | null;
  contactId: string;
};
type Channels = { channels: { channel: string; status: string; source: string | null }[] };

let cookieA: string;
let cookieB: string;
let orgA: string;
let seq = 0;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

async function mk(
  cookie: string,
  fields: Record<string, unknown> & { displayName: string },
): Promise<ContactJson> {
  seq += 1;
  const r = await post('/api/v1/contacts', cookie, {
    phone: `+1202555${String(2000 + seq).padStart(4, '0')}`,
    ...fields,
  });
  const json = (await r.json()) as Envelope<ContactJson>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data;
}

const uniqueName = (base: string) => `${base} ${crypto.randomUUID().slice(0, 8)}`;

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${r.status} ${JSON.stringify(json.error)}`);
  return json.data;
}

const duplicates = async (cookie: string, id: string) =>
  data<{ items: Suggestion[] }>(await get(`/api/v1/contacts/${id}/duplicates`, cookie));
const merge = (cookie: string, target: string, sourceId: string) =>
  post(`/api/v1/contacts/${target}/merge`, cookie, { sourceId });
const dismiss = (cookie: string, id: string, other: string) =>
  post(`/api/v1/contacts/${id}/duplicates/${other}/dismiss`, cookie, {});
const timeline = async (cookie: string, id: string) =>
  (
    await data<{ items: TimelineItem[] }>(
      await get(`/api/v1/contacts/${id}/timeline?limit=200`, cookie),
    )
  ).items;
const permissions = async (cookie: string, id: string) =>
  data<Channels>(await get(`/api/v1/contacts/${id}/permissions`, cookie));
const audits = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));

function put(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const rowOf = (id: string) =>
  withAdminDb(async (db) => {
    const [row] = await db.select().from(contact).where(eq(contact.id, id));
    return row;
  });

const dismissalsOf = (...ids: string[]) =>
  withAdminDb((db) =>
    db
      .select()
      .from(contactDuplicateDismissal)
      .where(
        or(
          ...ids.flatMap((id) => [
            eq(contactDuplicateDismissal.contactAId, id),
            eq(contactDuplicateDismissal.contactBId, id),
          ]),
        ),
      ),
  );

const LOCK_WAIT_LIMIT_MS = 10_000;
const HOLDER_LOCK_TIMEOUT = '15s';

/**
 * Polls until exactly `count` distinct sessions are blocked on a lock inside the tagged
 * lock-pair statement (merge and dismiss). Other sessions in the database cannot satisfy it.
 * Each poll opens its own admin connection, separate from the holder's.
 */
async function waitForLockWaiters(count: number): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_LIMIT_MS;
  let waiting = 0;
  while (Date.now() < deadline) {
    waiting = await withAdminDb(async (db) => {
      const result = await db.execute(sql`select count(distinct pid)::int as n
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
        and query like '%knoqra:lock-pair%'`);
      return Number((result.rows[0] as { n: number }).n);
    });
    if (waiting === count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected ${count} lock waiters, saw ${waiting}`);
}

/**
 * Holds FOR UPDATE on the rows in a separate transaction, fires the requests, proves they are
 * blocked on the lock (none has resolved), then releases and returns their responses.
 * The holder's lock_timeout keeps a stale session from hanging the suite.
 */
async function whileLocked(
  ids: string[],
  waiters: number,
  fire: () => Promise<Response>[],
): Promise<Response[]> {
  let pending: Promise<Response>[] = [];
  try {
    await withAdminDb((db) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${HOLDER_LOCK_TIMEOUT}'`));
        await tx.select().from(contact).where(inArray(contact.id, ids)).for('update');
        let resolved = 0;
        pending = fire().map((p) =>
          p.finally(() => {
            resolved += 1;
          }),
        );
        await waitForLockWaiters(waiters);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(resolved).toBe(0);
      }),
    );
  } catch (error) {
    // Let in-flight requests finish (the lock is released) so none leaks an unhandled rejection.
    await Promise.allSettled(pending);
    throw error;
  }
  return Promise.all(pending);
}

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('dup-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('dup-b'), 'Owner B');
  orgA = await orgOf(cookieA);
});

describe('GET duplicates', () => {
  it('suggests case- and whitespace-insensitive name matches', async () => {
    const name = uniqueName('Maya Okafor');
    const a = await mk(cookieA, { displayName: name });
    const b = await mk(cookieA, { displayName: `  ${name.toLowerCase().replace(' ', '   ')}  ` });
    const { items } = await duplicates(cookieA, a.id);
    expect(items.map((i) => i.contact.id)).toEqual([b.id]);
    expect(items[0]?.reasons).toEqual(['same_name']);
  });

  it('matches email case-insensitively and lists every reason once per candidate', async () => {
    const name = uniqueName('Reason Person');
    const email = `Shared-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const a = await mk(cookieA, { displayName: name, company: 'Acme', email });
    const both = await mk(cookieA, {
      displayName: name.toUpperCase(),
      company: 'ACME',
      email: email.toLowerCase(),
    });
    const emailOnly = await mk(cookieA, { displayName: uniqueName('Other'), email });
    const nameOnly = await mk(cookieA, { displayName: name, company: 'Globex' });
    const { items } = await duplicates(cookieA, a.id);
    expect(items.map((i) => i.contact.id)).toEqual([both.id, emailOnly.id, nameOnly.id]);
    expect(items[0]?.reasons.toSorted()).toEqual(
      ['same_email', 'same_name', 'same_name_and_company'].toSorted(),
    );
    expect(items[1]?.reasons).toEqual(['same_email']);
    expect(items[2]?.reasons).toEqual(['same_name']);
  });

  it('never treats two missing emails or two missing companies as a match', async () => {
    const a = await mk(cookieA, { displayName: uniqueName('Nulls A') });
    await mk(cookieA, { displayName: uniqueName('Nulls B') });
    expect((await duplicates(cookieA, a.id)).items).toEqual([]);
  });

  it('excludes self, archived and merged contacts and caps at five', async () => {
    const name = uniqueName('Cap Person');
    const subject = await mk(cookieA, { displayName: name });
    const archived = await mk(cookieA, { displayName: name });
    const merged = await mk(cookieA, { displayName: name });
    await post(`/api/v1/contacts/${archived.id}/archive`, cookieA, {});
    expect((await merge(cookieA, subject.id, merged.id)).status).toBe(200);
    const live: string[] = [];
    for (let i = 0; i < 7; i += 1) live.push((await mk(cookieA, { displayName: name })).id);
    const { items } = await duplicates(cookieA, subject.id);
    expect(items).toHaveLength(5);
    const ids = items.map((i) => i.contact.id);
    expect(ids).not.toContain(subject.id);
    expect(ids).not.toContain(archived.id);
    expect(ids).not.toContain(merged.id);
    expect(ids).toEqual([...live].sort().slice(0, 5));
  });

  it('returns nothing for an archived or merged subject', async () => {
    const name = uniqueName('Quiet Person');
    const a = await mk(cookieA, { displayName: name });
    const b = await mk(cookieA, { displayName: name });
    const c = await mk(cookieA, { displayName: name });
    await post(`/api/v1/contacts/${a.id}/archive`, cookieA, {});
    expect((await duplicates(cookieA, a.id)).items).toEqual([]);
    expect((await merge(cookieA, c.id, b.id)).status).toBe(200);
    expect((await duplicates(cookieA, b.id)).items).toEqual([]);
  });

  it('404s unknown, cross-tenant and malformed ids, and needs a session', async () => {
    const a = await mk(cookieA, { displayName: uniqueName('Hidden') });
    expect((await get(`/api/v1/contacts/${a.id}/duplicates`, cookieB)).status).toBe(404);
    expect((await get(`/api/v1/contacts/${newId('ct')}/duplicates`, cookieA)).status).toBe(404);
    expect((await get('/api/v1/contacts/nope/duplicates', cookieA)).status).toBe(404);
    expect((await get(`/api/v1/contacts/${a.id}/duplicates`)).status).toBe(401);
  });
});

describe('POST dismiss', () => {
  it('hides the pair in both directions, idempotently, and audits it', async () => {
    const name = uniqueName('Dismiss Person');
    const a = await mk(cookieA, { displayName: name });
    const b = await mk(cookieA, { displayName: name });
    expect((await duplicates(cookieA, a.id)).items).toHaveLength(1);
    expect((await dismiss(cookieA, a.id, b.id)).status).toBe(204);
    expect((await dismiss(cookieA, b.id, a.id)).status).toBe(204);
    expect((await duplicates(cookieA, a.id)).items).toEqual([]);
    expect((await duplicates(cookieA, b.id)).items).toEqual([]);
    const rows = await dismissalsOf(a.id, b.id);
    expect(rows).toHaveLength(1);
    const [lo, hi] = [a.id, b.id].sort();
    expect(rows[0]).toMatchObject({ contactAId: lo, contactBId: hi });
    const log = (await audits(orgA)).filter((e) => e.action === 'contact.duplicate.dismiss');
    expect(log.some((e) => e.entityId === a.id && e.metadata?.otherId === b.id)).toBe(true);
  });

  it('422s self and 404s unknown, cross-tenant and malformed ids', async () => {
    const a = await mk(cookieA, { displayName: uniqueName('Dismiss Edge') });
    const other = await mk(cookieA, { displayName: uniqueName('Dismiss Edge') });
    expect((await dismiss(cookieA, a.id, a.id)).status).toBe(422);
    expect((await dismiss(cookieA, a.id, newId('ct'))).status).toBe(404);
    expect((await dismiss(cookieA, a.id, 'nope')).status).toBe(404);
    expect((await dismiss(cookieA, newId('ct'), a.id)).status).toBe(404);
    expect((await dismiss(cookieB, a.id, other.id)).status).toBe(404);
    expect(await dismissalsOf(a.id, other.id)).toEqual([]);
  });
});

describe('POST merge', () => {
  it('moves notes and consent, fills gaps, unions tags and retires the source', async () => {
    const target = await mk(cookieA, {
      displayName: uniqueName('Target'),
      company: 'Keep Co',
      tags: ['vip', 'shared'],
    });
    const source = await mk(cookieA, {
      displayName: uniqueName('Source'),
      company: 'Drop Co',
      email: 'fill@example.test',
      jobTitle: 'CTO',
      timezone: 'Europe/Paris',
      tags: ['shared', 'new'],
    });
    await post(`/api/v1/contacts/${source.id}/notes`, cookieA, { body: 'Source note' });
    await post(`/api/v1/contacts/${target.id}/notes`, cookieA, { body: 'Target note' });
    await put(`/api/v1/contacts/${source.id}/permissions/sms`, cookieA, { status: 'granted' });

    const r = await merge(cookieA, target.id, source.id);
    expect(r.status).toBe(200);
    const merged = await data<ContactJson>(r);
    expect(merged).toMatchObject({
      id: target.id,
      company: 'Keep Co',
      email: 'fill@example.test',
      jobTitle: 'CTO',
      timezone: 'Europe/Paris',
      tags: ['vip', 'shared', 'new'],
    });

    const items = await timeline(cookieA, target.id);
    expect(items.every((i) => i.contactId === target.id)).toBe(true);
    const noteBodies = items.filter((i) => i.kind === 'note').map((i) => i.body);
    expect(noteBodies.toSorted()).toEqual(['Source note', 'Target note']);
    expect(items.some((i) => i.title.startsWith('SMS consent'))).toBe(true);
    expect(items.find((i) => i.refType === 'contact')).toMatchObject({
      kind: 'system',
      title: `Merged ${source.displayName} into this contact`,
      refId: source.id,
    });
    expect(await timeline(cookieA, source.id)).toEqual([]);

    const perms = await permissions(cookieA, target.id);
    expect(perms.channels.find((c) => c.channel === 'sms')?.status).toBe('granted');

    const row = await rowOf(source.id);
    expect(row?.mergedIntoId).toBe(target.id);
    expect(row?.archivedAt).not.toBeNull();
    const list = await data<Page>(await get('/api/v1/contacts?q=Source&limit=200', cookieA));
    expect(list.items.map((i) => i.id)).not.toContain(source.id);
    const log = (await audits(orgA)).find(
      (e) => e.action === 'contact.merge' && e.entityId === target.id,
    );
    expect(log).toMatchObject({ outcome: 'allowed', metadata: { sourceId: source.id } });
  });

  it("lets the source's newer do_not_contact win over the target's older grant", async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Consent T') });
    const source = await mk(cookieA, { displayName: uniqueName('Consent S') });
    await put(`/api/v1/contacts/${target.id}/permissions/sms`, cookieA, { status: 'granted' });
    await post(`/api/v1/contacts/${source.id}/do-not-contact`, cookieA, {});
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);
    const perms = await permissions(cookieA, target.id);
    expect(perms.channels.find((c) => c.channel === 'sms')?.status).toBe('do_not_contact');
    const events = await withAdminDb((db) =>
      db
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, target.id)),
    );
    expect(events).toHaveLength(1 + 5);
  });

  const permissionEventsOf = (contactId: string) =>
    withAdminDb((db) =>
      db
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, contactId)),
    );
  const sms = async (contactId: string) =>
    (await permissions(cookieA, contactId)).channels.find((c) => c.channel === 'sms');

  it("keeps the target's do_not_contact over the source's newer grant", async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Keep DNC T') });
    const source = await mk(cookieA, { displayName: uniqueName('Keep DNC S') });
    await post(`/api/v1/contacts/${target.id}/do-not-contact`, cookieA, {});
    await put(`/api/v1/contacts/${source.id}/permissions/sms`, cookieA, { status: 'granted' });
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);

    expect(await sms(target.id)).toMatchObject({ status: 'do_not_contact', source: 'merge' });
    const perms = await permissions(cookieA, target.id);
    expect(perms.channels.every((c) => c.status === 'do_not_contact')).toBe(true);
    const events = await permissionEventsOf(target.id);
    expect(events).toHaveLength(5 + 1 + 1);
    const kept = events.filter((e) => e.source === 'merge');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ channel: 'sms', status: 'do_not_contact' });
    const consent = (await timeline(cookieA, target.id)).find((i) => i.refId === kept[0]?.id);
    expect(consent).toMatchObject({
      kind: 'consent',
      title: 'SMS consent kept as do not contact after merge',
      refType: 'contact_permission_event',
    });
    const log = (await audits(orgA)).find(
      (e) => e.action === 'contact.merge' && e.entityId === target.id,
    );
    expect(log?.metadata).toMatchObject({ sourceId: source.id, keptConsent: ['sms'] });
  });

  it("keeps the source's opt-out over the target's newer grant", async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Keep Out T') });
    const source = await mk(cookieA, { displayName: uniqueName('Keep Out S') });
    await put(`/api/v1/contacts/${source.id}/permissions/sms`, cookieA, { status: 'opted_out' });
    await put(`/api/v1/contacts/${target.id}/permissions/sms`, cookieA, { status: 'granted' });
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);

    expect(await sms(target.id)).toMatchObject({ status: 'opted_out', source: 'merge' });
    const kept = (await permissionEventsOf(target.id)).filter((e) => e.source === 'merge');
    expect(kept.map((e) => [e.channel, e.status])).toEqual([['sms', 'opted_out']]);
    const titles = (await timeline(cookieA, target.id)).map((i) => i.title);
    expect(titles).toContain('SMS consent kept as opted out after merge');
  });

  it('writes no extra consent event when both contacts granted', async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Both T') });
    const source = await mk(cookieA, { displayName: uniqueName('Both S') });
    await put(`/api/v1/contacts/${target.id}/permissions/sms`, cookieA, { status: 'granted' });
    await put(`/api/v1/contacts/${source.id}/permissions/sms`, cookieA, { status: 'granted' });
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);

    expect(await sms(target.id)).toMatchObject({ status: 'granted', source: 'manual' });
    const events = await permissionEventsOf(target.id);
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.source === 'merge')).toBe(false);
    const titles = (await timeline(cookieA, target.id)).map((i) => i.title);
    expect(titles.some((t) => t.includes('after merge'))).toBe(false);
  });

  /** Writes one SMS consent event straight through the admin connection, at a set time and id. */
  const seedSms = (
    contactId: string,
    status: 'granted' | 'opted_out',
    id: string,
    createdAt: ReturnType<typeof sql>,
  ) =>
    withAdminDb((db) =>
      db.insert(contactPermissionEvent).values({
        id,
        organizationId: orgA,
        contactId,
        channel: 'sms',
        status,
        source: 'manual',
        createdAt: createdAt as unknown as Date,
      }),
    );
  const latestSmsOf = (contactId: string) =>
    withAdminDb(async (db) => {
      const [row] = await db
        .select()
        .from(contactPermissionEvent)
        .where(
          sql`${contactPermissionEvent.contactId} = ${contactId} and ${contactPermissionEvent.channel} = 'sms'`,
        )
        .orderBy(sql`${contactPermissionEvent.createdAt} desc, ${contactPermissionEvent.id} desc`)
        .limit(1);
      return row;
    });

  it('keeps the opt-out when both latest events share a timestamp, whichever id is higher', async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const cases = [
      // Identical created_at: the database breaks the tie by id. The grant has the higher id
      // here, so the combined history would surface it without a merge event.
      {
        grantAt: '2026-01-01 10:00:00.000500+00',
        outAt: '2026-01-01 10:00:00.000500+00',
        grantId: `cp_z${tag}`,
        outId: `cp_a${tag}`,
      },
      // Identical created_at, the opt-out has the higher id: it is already the combined latest.
      {
        grantAt: '2026-01-01 10:00:00.000500+00',
        outAt: '2026-01-01 10:00:00.000500+00',
        grantId: `cp_b${tag}`,
        outId: `cp_y${tag}`,
      },
      // Same millisecond, the grant is later by microseconds but has the lower id: a
      // millisecond comparison in JS would pick the opt-out, the database picks the grant.
      {
        grantAt: '2026-01-01 10:00:00.000900+00',
        outAt: '2026-01-01 10:00:00.000100+00',
        grantId: `cp_c${tag}`,
        outId: `cp_x${tag}`,
      },
    ];
    for (const c of cases) {
      const target = await mk(cookieA, { displayName: uniqueName('Tie T') });
      const source = await mk(cookieA, { displayName: uniqueName('Tie S') });
      await seedSms(target.id, 'granted', c.grantId, sql`${c.grantAt}::timestamptz`);
      await seedSms(source.id, 'opted_out', c.outId, sql`${c.outAt}::timestamptz`);
      expect((await merge(cookieA, target.id, source.id)).status).toBe(200);

      expect(await sms(target.id)).toMatchObject({ status: 'opted_out' });
      expect(await latestSmsOf(target.id)).toMatchObject({ status: 'opted_out' });
    }
  });

  it("keeps the target's do_not_contact over a source grant stamped in the future", async () => {
    // Stands in for a clock step back between the grant and the merge.
    const target = await mk(cookieA, { displayName: uniqueName('Clock T') });
    const source = await mk(cookieA, { displayName: uniqueName('Clock S') });
    await post(`/api/v1/contacts/${target.id}/do-not-contact`, cookieA, {});
    await seedSms(source.id, 'granted', newId('cp'), sql`clock_timestamp() + interval '1 hour'`);
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);

    expect(await sms(target.id)).toMatchObject({ status: 'do_not_contact', source: 'merge' });
    expect(await latestSmsOf(target.id)).toMatchObject({
      status: 'do_not_contact',
      source: 'merge',
    });
  });

  it("releases the source's number: the target or a new contact can take it", async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Number T') });
    const first = await mk(cookieA, { displayName: uniqueName('Number S1') });
    const second = await mk(cookieA, { displayName: uniqueName('Number S2') });
    expect((await merge(cookieA, target.id, first.id)).status).toBe(200);
    expect((await merge(cookieA, target.id, second.id)).status).toBe(200);
    const firstPhone = (await rowOf(first.id))?.phoneE164;
    const secondPhone = (await rowOf(second.id))?.phoneE164;

    const moved = await api(`/api/v1/contacts/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ phone: firstPhone }),
    });
    expect(moved.status).toBe(200);
    expect((await data<{ phoneE164: string }>(moved)).phoneE164).toBe(firstPhone);

    const fresh = await post('/api/v1/contacts', cookieA, {
      displayName: uniqueName('Number New'),
      phone: secondPhone,
    });
    expect(fresh.status).toBe(201);
    // Both merged rows still hold their numbers, as history.
    expect((await rowOf(first.id))?.phoneE164).toBe(firstPhone);
    expect((await rowOf(second.id))?.phoneE164).toBe(secondPhone);
  });

  it('deletes dismissals that involve the source', async () => {
    const name = uniqueName('Dismissed Then Merged');
    const target = await mk(cookieA, { displayName: uniqueName('DM Target') });
    const source = await mk(cookieA, { displayName: name });
    const bystander = await mk(cookieA, { displayName: name });
    await dismiss(cookieA, source.id, bystander.id);
    await dismiss(cookieA, source.id, target.id);
    expect(await dismissalsOf(source.id)).toHaveLength(2);
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);
    expect(await dismissalsOf(source.id)).toEqual([]);
  });

  it('caps the tag union at 20', async () => {
    const tags = (p: string) => Array.from({ length: 15 }, (_, i) => `${p}${i}`);
    const target = await mk(cookieA, { displayName: uniqueName('Tags T'), tags: tags('a') });
    const source = await mk(cookieA, { displayName: uniqueName('Tags S'), tags: tags('b') });
    const merged = await data<ContactJson>(await merge(cookieA, target.id, source.id));
    expect(merged.tags).toHaveLength(20);
    expect(merged.tags.slice(0, 15)).toEqual(tags('a'));
  });

  it('refuses self, merged and archived contacts, and bad ids', async () => {
    const a = await mk(cookieA, { displayName: uniqueName('Refuse A') });
    const b = await mk(cookieA, { displayName: uniqueName('Refuse B') });
    const c = await mk(cookieA, { displayName: uniqueName('Refuse C') });
    const d = await mk(cookieA, { displayName: uniqueName('Refuse D') });
    const self = await merge(cookieA, a.id, a.id);
    expect(self.status).toBe(422);
    expect(((await self.json()) as Envelope<null>).error?.message).toBe(
      'A contact cannot be merged into itself',
    );
    expect((await merge(cookieA, a.id, b.id)).status).toBe(200);
    const again = await merge(cookieA, c.id, b.id);
    expect(again.status).toBe(422);
    expect(((await again.json()) as Envelope<null>).error?.message).toBe(
      'This contact was already merged or archived',
    );
    await post(`/api/v1/contacts/${d.id}/archive`, cookieA, {});
    expect((await merge(cookieA, c.id, d.id)).status).toBe(422);
    const intoArchived = await merge(cookieA, d.id, c.id);
    expect(intoArchived.status).toBe(422);
    expect(((await intoArchived.json()) as Envelope<null>).error?.message).toBe(
      'Restore this contact first',
    );
    expect((await merge(cookieA, b.id, c.id)).status).toBe(422);
    expect((await merge(cookieA, a.id, newId('ct'))).status).toBe(404);
    expect((await merge(cookieA, newId('ct'), a.id)).status).toBe(404);
    expect((await merge(cookieA, a.id, 'nope')).status).toBe(404);
    expect((await merge(cookieA, 'nope', a.id)).status).toBe(404);
    expect((await post(`/api/v1/contacts/${a.id}/merge`, cookieA, {})).status).toBe(400);
    const log = await audits(orgA);
    expect(log.some((e) => e.action === 'contact.merge' && e.outcome === 'denied')).toBe(true);
    expect(log.some((e) => e.action === 'contact.merge' && e.outcome === 'not_found')).toBe(true);
  });

  it('404s across tenants and leaves the other org untouched', async () => {
    const a1 = await mk(cookieA, { displayName: uniqueName('Iso 1') });
    const a2 = await mk(cookieA, { displayName: uniqueName('Iso 2') });
    const b1 = await mk(cookieB, { displayName: uniqueName('Iso B') });
    expect((await merge(cookieB, a1.id, a2.id)).status).toBe(404);
    expect((await merge(cookieB, b1.id, a2.id)).status).toBe(404);
    expect((await merge(cookieB, a1.id, b1.id)).status).toBe(404);
    for (const id of [a1.id, a2.id]) {
      const row = await rowOf(id);
      expect(row?.mergedIntoId).toBeNull();
      expect(row?.archivedAt).toBeNull();
    }
    const events = await withAdminDb((db) =>
      db
        .select()
        .from(timelineEvent)
        .where(or(eq(timelineEvent.contactId, a1.id), eq(timelineEvent.contactId, a2.id))),
    );
    expect(events.filter((e) => e.title.startsWith('Merged'))).toEqual([]);
  });

  it('lets exactly one of two identical merges win while both wait on the row lock', async () => {
    const target = await mk(cookieA, { displayName: uniqueName('Race T') });
    const source = await mk(cookieA, { displayName: uniqueName('Race S') });
    const pending = await whileLocked([target.id], 2, () => [
      merge(cookieA, target.id, source.id),
      merge(cookieA, target.id, source.id),
    ]);
    const statuses = pending.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([404, 422]).toContain(statuses[1]);
    const merges = (await timeline(cookieA, target.id)).filter((i) => i.refId === source.id);
    expect(merges).toHaveLength(1);
  }, 30_000);

  it('lets exactly one of two opposite merges win while both wait, with no deadlock', async () => {
    const a = await mk(cookieA, { displayName: uniqueName('Opp A') });
    const b = await mk(cookieA, { displayName: uniqueName('Opp B') });
    const results = await whileLocked([a.id, b.id], 2, () => [
      merge(cookieA, a.id, b.id),
      merge(cookieA, b.id, a.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
  }, 30_000);

  it('never leaves a dismissal naming a merged source when dismiss races merge', async () => {
    const target = await mk(cookieA, { displayName: uniqueName('DR T') });
    const source = await mk(cookieA, { displayName: uniqueName('DR S') });
    const [mergeRes, dismissRes] = await whileLocked([target.id, source.id], 2, () => [
      merge(cookieA, target.id, source.id),
      dismiss(cookieA, source.id, target.id),
    ]);
    expect(mergeRes?.status).toBe(200);
    expect([204, 422]).toContain(dismissRes?.status);
    // Order-independent: if dismiss won, merge then deletes every dismissal involving the
    // source; if merge won, dismiss is refused. Either way none remains.
    expect(await dismissalsOf(source.id)).toEqual([]);
  }, 30_000);

  it('refuses to dismiss a merged contact', async () => {
    const target = await mk(cookieA, { displayName: uniqueName('DM2 T') });
    const source = await mk(cookieA, { displayName: uniqueName('DM2 S') });
    const other = await mk(cookieA, { displayName: uniqueName('DM2 O') });
    expect((await merge(cookieA, target.id, source.id)).status).toBe(200);
    const r = await dismiss(cookieA, other.id, source.id);
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<null>).error?.message).toBe(
      'This contact was already merged',
    );
    expect(await dismissalsOf(source.id)).toEqual([]);
  });
});

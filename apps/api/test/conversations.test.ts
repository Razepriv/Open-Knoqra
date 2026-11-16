import { auditEvent, contact, contactPermissionEvent, conversation, withTenant } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Composer = { mode: string; reason: string; windowExpiresAt: string | null };
type Conv = {
  id: string;
  channel: string;
  contact: { id: string; displayName: string; phone: string; company: string | null };
  lastActivityAt: string;
  lastInboundAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  composer: Composer;
  sender?: { registrationStatus: string } | null;
};
type Item =
  | { kind: 'message'; message: { id: string; body: string; templateName: string | null } }
  | {
      kind: 'note';
      note: { id: string; body: string; authorUserId: string | null; authorName: string | null };
    };
type Page<T> = { items: T[]; nextCursor: string | null };

interface Org {
  cookie: string;
  orgId: string;
}

/** Reserved 555-01xx numbers; the counter is per org, as phone uniqueness is per org. */
const phoneSeq = new Map<string, number>();
const nextPhone = (org: Org) => {
  const n = (phoneSeq.get(org.orgId) ?? 99) + 1;
  if (n > 199) throw new Error('out of 555-01xx test numbers');
  phoneSeq.set(org.orgId, n);
  return `+1202555${String(n).padStart(4, '0')}`;
};

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

async function setupOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  return { cookie, orgId: await orgOf(cookie) };
}

function put(path: string, cookie: string, body: unknown) {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const sandbox = (org: Org, sms: string, whatsapp: string) =>
  put('/api/v1/messaging/sandbox', org.cookie, { sms, whatsapp });

const tenant = <T>(org: Org, fn: Parameters<typeof withTenant<T>>[2]) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

interface Seed {
  name?: string;
  channel?: 'sms' | 'whatsapp';
  consent?: 'granted' | 'unknown';
  inbound?: { body: string; at: Date } | null;
  activityAt?: Date;
}

/** A contact plus conversation; optional consent event and inbound message. */
async function seed(org: Org, opts: Seed = {}) {
  const channel = opts.channel ?? 'sms';
  return tenant(org, async (tx) => {
    const [c] = await tx
      .insert(contact)
      .values({
        organizationId: org.orgId,
        displayName: opts.name ?? 'Seeded',
        phoneE164: nextPhone(org),
        company: 'Acme',
      })
      .returning();
    if (!c) throw new Error('contact insert failed');
    if (opts.consent === 'granted') {
      await tx.insert(contactPermissionEvent).values({
        organizationId: org.orgId,
        contactId: c.id,
        channel,
        status: 'granted',
        source: 'manual',
      });
    }
    const conv = await ensureConversation(tx, org.orgId, c.id, channel);
    if (opts.inbound) {
      await insertMessage(tx, {
        orgId: org.orgId,
        conversation: conv,
        direction: 'inbound',
        body: opts.inbound.body,
        status: 'received',
        provider: 'fake',
        providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
        occurredAt: opts.inbound.at,
      });
    }
    if (opts.activityAt) {
      await tx
        .update(conversation)
        .set({ lastActivityAt: opts.activityAt })
        .where(eq(conversation.id, conv.id));
    }
    return { contactId: c.id, conversationId: conv.id, phone: c.phoneE164 };
  });
}

const detail = async (org: Org, id: string) => {
  const r = await get(`/api/v1/conversations/${id}`, org.cookie);
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<Conv>).data as Conv;
};

const list = async (org: Org, query = '') => {
  const r = await get(`/api/v1/conversations${query}`, org.cookie);
  return { status: r.status, body: (await r.json()) as Envelope<Page<Conv>> };
};

const auditCount = (org: Org, action: string, outcome: 'allowed' | 'not_found') =>
  withAdminDb(async (db) => {
    const rows = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, org.orgId),
          eq(auditEvent.action, action),
          eq(auditEvent.outcome, outcome),
        ),
      );
    return rows.length;
  });

const bodyOf = (i: Item) => (i.kind === 'message' ? i.message.body : i.note.body);

let orgA: Org;
let orgB: Org;
let listOrg: Org;
let pageOrg: Org;

beforeAll(async () => {
  orgA = await setupOrg('cv-a');
  orgB = await setupOrg('cv-b');
  listOrg = await setupOrg('cv-list');
  pageOrg = await setupOrg('cv-page');
});

describe('conversation list', () => {
  it('orders by activity and narrows by filter and q', async () => {
    const base = Date.now();
    const oldest = await seed(listOrg, { name: 'Alice Old', activityAt: new Date(base - 3000) });
    const wa = await seed(listOrg, {
      name: 'Bob Wa',
      channel: 'whatsapp',
      inbound: { body: 'hey', at: new Date(base - 2000) },
      activityAt: new Date(base - 2000),
    });
    const newest = await seed(listOrg, { name: 'Cara New', activityAt: new Date(base - 1000) });
    const all = await list(listOrg);
    expect(all.status).toBe(200);
    expect(all.body.data?.items.map((i) => i.id)).toEqual([
      newest.conversationId,
      wa.conversationId,
      oldest.conversationId,
    ]);
    expect(all.body.data?.items[2]?.contact).toMatchObject({
      displayName: 'Alice Old',
      company: 'Acme',
      phone: oldest.phone,
    });
    const unread = await list(listOrg, '?filter=unread');
    expect(unread.body.data?.items.map((i) => i.id)).toEqual([wa.conversationId]);
    const whatsapp = await list(listOrg, '?filter=whatsapp');
    expect(whatsapp.body.data?.items.map((i) => i.id)).toEqual([wa.conversationId]);
    const sms = await list(listOrg, '?filter=sms');
    expect(sms.body.data?.items).toHaveLength(2);
    const byName = await list(listOrg, '?q=cara');
    expect(byName.body.data?.items.map((i) => i.id)).toEqual([newest.conversationId]);
    const byPhone = await list(listOrg, `?q=${encodeURIComponent(oldest.phone)}`);
    expect(byPhone.body.data?.items.map((i) => i.id)).toEqual([oldest.conversationId]);
  });

  it('pages 55 conversations as 50 then 5 without duplicates', async () => {
    const base = Date.now() - 100_000;
    await tenant(pageOrg, async (tx) => {
      for (let i = 0; i < 55; i += 1) {
        const [c] = await tx
          .insert(contact)
          .values({
            organizationId: pageOrg.orgId,
            displayName: `P${i}`,
            phoneE164: nextPhone(pageOrg),
          })
          .returning();
        if (!c) throw new Error('contact insert failed');
        const conv = await ensureConversation(tx, pageOrg.orgId, c.id, 'sms');
        // Pairs share a timestamp so the id tiebreak is exercised.
        await tx
          .update(conversation)
          .set({ lastActivityAt: new Date(base + Math.floor(i / 2) * 1000) })
          .where(eq(conversation.id, conv.id));
      }
    });
    const first = await list(pageOrg);
    expect(first.body.data?.items).toHaveLength(50);
    expect(first.body.data?.nextCursor).toEqual(expect.any(String));
    const second = await list(
      pageOrg,
      `?cursor=${encodeURIComponent(first.body.data?.nextCursor as string)}`,
    );
    expect(second.body.data?.items).toHaveLength(5);
    expect(second.body.data?.nextCursor).toBeNull();
    const ids = [...(first.body.data?.items ?? []), ...(second.body.data?.items ?? [])].map(
      (i) => i.id,
    );
    expect(new Set(ids).size).toBe(55);
  });

  it('answers 400 for a garbage cursor', async () => {
    const r = await list(listOrg, '?cursor=garbage');
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('validation_error');
  });
});

describe('composer state on the detail endpoint', () => {
  it('walks through every mode', async () => {
    const noSender = await seed(orgA, { consent: 'granted' });
    const noSenderDetail = await detail(orgA, noSender.conversationId);
    expect(noSenderDetail.composer).toMatchObject({ mode: 'paused', reason: 'no_sender' });
    expect(noSenderDetail.sender).toBeNull();

    await sandbox(orgA, 'pending', 'approved');
    const pending = await seed(orgA, { consent: 'granted' });
    const pendingDetail = await detail(orgA, pending.conversationId);
    expect(pendingDetail.composer).toMatchObject({
      mode: 'paused',
      reason: 'registration_pending',
    });
    expect(pendingDetail.sender?.registrationStatus).toBe('pending');

    const unknown = await seed(orgA, { consent: 'unknown' });
    expect((await detail(orgA, unknown.conversationId)).composer).toMatchObject({
      mode: 'blocked',
      reason: 'consent_required',
    });

    await sandbox(orgA, 'approved', 'approved');
    const free = await seed(orgA, { consent: 'granted' });
    expect((await detail(orgA, free.conversationId)).composer).toEqual({
      mode: 'free',
      reason: 'ok',
      windowExpiresAt: null,
    });

    const waClosed = await seed(orgA, { channel: 'whatsapp', consent: 'granted' });
    expect((await detail(orgA, waClosed.conversationId)).composer).toMatchObject({
      mode: 'template_only',
      reason: 'window_closed',
    });
  });

  it('includes the composer on list rows', async () => {
    const r = await list(orgA);
    expect(r.body.data?.items.length).toBeGreaterThan(0);
    for (const item of r.body.data?.items ?? []) {
      expect(item.composer.mode).toEqual(expect.any(String));
    }
  });
});

describe('create conversation', () => {
  it('answers 201 then 200 with the same id', async () => {
    const [c] = await tenant(orgB, (tx) =>
      tx
        .insert(contact)
        .values({ organizationId: orgB.orgId, displayName: 'Fresh', phoneE164: nextPhone(orgB) })
        .returning(),
    );
    const id = (c as { id: string }).id;
    const a = await post('/api/v1/conversations', orgB.cookie, { contactId: id, channel: 'sms' });
    expect(a.status).toBe(201);
    const b = await post('/api/v1/conversations', orgB.cookie, { contactId: id, channel: 'sms' });
    expect(b.status).toBe(200);
    const ja = (await a.json()) as Envelope<Conv>;
    const jb = (await b.json()) as Envelope<Conv>;
    expect(ja.data?.id).toBe(jb.data?.id);
    expect(ja.data?.contact.id).toBe(id);
    expect(await auditCount(orgB, 'conversation.create', 'allowed')).toBeGreaterThan(0);
  });

  it('refuses an archived contact with 422 and a missing one with 404 plus audit', async () => {
    const archived = await seed(orgB);
    await tenant(orgB, (tx) =>
      tx.update(contact).set({ archivedAt: new Date() }).where(eq(contact.id, archived.contactId)),
    );
    const r = await post('/api/v1/conversations', orgB.cookie, {
      contactId: archived.contactId,
      channel: 'whatsapp',
    });
    expect(r.status).toBe(422);
    const before = await auditCount(orgB, 'conversation.create', 'not_found');
    const missing = await post('/api/v1/conversations', orgB.cookie, {
      contactId: `ct_${'0'.repeat(32)}`,
      channel: 'sms',
    });
    expect(missing.status).toBe(404);
    expect(await auditCount(orgB, 'conversation.create', 'not_found')).toBe(before + 1);
  });
});

describe('items, notes and read', () => {
  it('interleaves an inbound message and a note, paginates, and mirrors the note on the timeline', async () => {
    const s = await seed(orgA, {
      name: 'Thread',
      inbound: { body: 'first inbound', at: new Date(Date.now() - 60_000) },
    });
    const noteRes = await post(`/api/v1/conversations/${s.conversationId}/notes`, orgA.cookie, {
      body: 'internal note',
    });
    expect(noteRes.status).toBe(201);
    const note = ((await noteRes.json()) as Envelope<Item>).data;
    expect(note).toMatchObject({
      kind: 'note',
      note: { body: 'internal note', authorName: 'Owner cv-a' },
    });
    const later = await tenant(orgA, async (tx) => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, s.conversationId));
      return insertMessage(tx, {
        orgId: orgA.orgId,
        conversation: conv as NonNullable<typeof conv>,
        direction: 'inbound',
        body: 'second inbound',
        status: 'received',
        provider: 'fake',
        providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
        occurredAt: new Date(Date.now() + 1000),
      });
    });

    const r = await get(`/api/v1/conversations/${s.conversationId}/items`, orgA.cookie);
    const items = ((await r.json()) as Envelope<Page<Item>>).data?.items ?? [];
    expect(items.map(bodyOf)).toEqual(['second inbound', 'internal note', 'first inbound']);
    expect(items[0]?.kind === 'message' && items[0].message.id).toBe(later.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const q: string = `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(`/api/v1/conversations/${s.conversationId}/items${q}`, orgA.cookie);
      const page = ((await res.json()) as Envelope<Page<Item>>).data as Page<Item>;
      for (const it of page.items) seen.push(bodyOf(it));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['second inbound', 'internal note', 'first inbound']);

    const tlRes = await get(`/api/v1/contacts/${s.contactId}/timeline`, orgA.cookie);
    const tl = (
      (await tlRes.json()) as Envelope<
        Page<{ kind: string; body: string | null; refType: string | null }>
      >
    ).data?.items;
    expect(
      tl?.some(
        (e) => e.kind === 'note' && e.body === 'internal note' && e.refType === 'conversation',
      ),
    ).toBe(true);
    expect(await auditCount(orgA, 'conversation.note.create', 'allowed')).toBeGreaterThan(0);
  });

  it('rejects a bad items cursor and an empty note with 400', async () => {
    const s = await seed(orgA);
    const bad = await get(
      `/api/v1/conversations/${s.conversationId}/items?cursor=zzz`,
      orgA.cookie,
    );
    expect(bad.status).toBe(400);
    const empty = await post(`/api/v1/conversations/${s.conversationId}/notes`, orgA.cookie, {
      body: '  ',
    });
    expect(empty.status).toBe(400);
  });

  it('marks a conversation read with 204', async () => {
    const s = await seed(orgA, { inbound: { body: 'ping', at: new Date() } });
    expect((await detail(orgA, s.conversationId)).unreadCount).toBe(1);
    const r = await post(`/api/v1/conversations/${s.conversationId}/read`, orgA.cookie, {});
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect((await detail(orgA, s.conversationId)).unreadCount).toBe(0);
  });
});

describe('tenant isolation', () => {
  it('answers 404 with a not_found audit in the caller org for a foreign conversation', async () => {
    const s = await seed(orgA, { inbound: { body: 'private', at: new Date() } });
    const id = s.conversationId;
    const calls: [string, () => Promise<Response>][] = [
      ['conversation.read', () => get(`/api/v1/conversations/${id}`, orgB.cookie)],
      ['conversation.read', () => get(`/api/v1/conversations/${id}/items`, orgB.cookie)],
      [
        'conversation.note.create',
        () => post(`/api/v1/conversations/${id}/notes`, orgB.cookie, { body: 'x' }),
      ],
      ['conversation.read', () => post(`/api/v1/conversations/${id}/read`, orgB.cookie, {})],
    ];
    for (const [action, call] of calls) {
      const before = await auditCount(orgB, action, 'not_found');
      const r = await call();
      expect(r.status).toBe(404);
      expect(await auditCount(orgB, action, 'not_found')).toBe(before + 1);
    }
    expect((await detail(orgA, id)).unreadCount).toBe(1);
  });

  it('answers 404 for a malformed id', async () => {
    expect((await get('/api/v1/conversations/not-an-id', orgA.cookie)).status).toBe(404);
    expect((await get('/api/v1/conversations/not-an-id/items', orgA.cookie)).status).toBe(404);
    expect((await post('/api/v1/conversations/not-an-id/read', orgA.cookie, {})).status).toBe(404);
  });
});

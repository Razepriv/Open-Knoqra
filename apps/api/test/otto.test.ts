import {
  auditEvent,
  member,
  ottoDraft,
  timelineEvent,
  usageEvent,
  user,
  withTenant,
} from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Draft = {
  id: string;
  kind: 'draft' | 'brief' | 'digest';
  contactId: string | null;
  channel: string | null;
  text: string;
  citations: { ref: string; kind: string; label: string }[];
  usage: { inputTokens: number; outputTokens: number };
  createdAt: string;
};

let cookieA: string;
let cookieB: string;
let orgA: string;
let userA: string;
let orgB: string;

async function meOf(cookie: string) {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!body.data) throw new Error('no me');
  return { orgId: body.data.organization.id, userId: body.data.user.id };
}
let phoneSeq = 0;
async function newContact(cookie: string, name: string): Promise<string> {
  phoneSeq += 1;
  const r = await post('/api/v1/contacts', cookie, {
    displayName: name,
    phone: `+1415555${String(Date.now() % 10000).padStart(4, '0')}${phoneSeq}`.slice(0, 12),
  });
  const body = (await r.json()) as Envelope<{ id: string }>;
  if (!body.data) throw new Error(`contact: ${r.status} ${JSON.stringify(body.error)}`);
  return body.data.id;
}
async function addNote(cookie: string, contactId: string, text: string) {
  const r = await post(`/api/v1/contacts/${contactId}/notes`, cookie, { body: text });
  const body = (await r.json()) as Envelope<{ id: string }>;
  if (!body.data) throw new Error(`note: ${r.status}`);
  return body.data.id;
}
async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${r.status} ${JSON.stringify(json.error)}`);
  return json.data;
}
const usageRows = (orgId: string, userId: string) =>
  withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx
        .select()
        .from(usageEvent)
        .where(and(eq(usageEvent.service, 'ai'), eq(usageEvent.userId, userId))),
    ),
  );

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('otto-a'), 'Otto A');
  cookieB = await signUp(uniqueEmail('otto-b'), 'Otto B');
  ({ orgId: orgA, userId: userA } = await meOf(cookieA));
  ({ orgId: orgB } = await meOf(cookieB));
});

describe('POST /api/v1/otto/drafts', () => {
  it('briefs from the contact timeline, cites the note and meters one usage event', async () => {
    const ct = await newContact(cookieA, 'Maya Okafor');
    const noteId = await addNote(cookieA, ct, 'Prefers mornings');
    const before = (await usageRows(orgA, userA)).length;
    const r = await post('/api/v1/otto/drafts', cookieA, { kind: 'brief', contactId: ct });
    expect(r.status).toBe(201);
    const d = await data<Draft>(r);
    expect(d.kind).toBe('brief');
    expect(d.contactId).toBe(ct);
    expect(d.channel).toBeNull();
    expect(d.text).toContain('Prefers mornings');
    expect(d.text).toContain('SMS: blocked · consent required');
    expect(d.citations.some((c) => c.kind === 'contact')).toBe(true);
    const cite = d.citations.find((c) => c.ref === noteId);
    expect(cite?.label.startsWith('Note')).toBe(true);
    const rows = await usageRows(orgA, userA);
    expect(rows).toHaveLength(before + 1);
    expect(rows.find((u) => u.refId === d.id)).toMatchObject({
      service: 'ai',
      unit: 'tokens',
      refType: 'otto_draft',
      provider: 'mock',
      costMicros: 0,
      idempotencyKey: `otto:${d.id}`,
      quantity: d.usage.inputTokens + d.usage.outputTokens,
    });
    const audits = await withAppDb((db) =>
      withTenant(db, orgA, (tx) =>
        tx.select().from(auditEvent).where(eq(auditEvent.entityId, d.id)),
      ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'otto.brief', outcome: 'allowed' });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('Prefers');
  });

  it('drafts for whatsapp, defaults the channel to sms and greets by first name', async () => {
    const ct = await newContact(cookieA, 'Jonas Berg');
    const wa = await data<Draft>(
      await post('/api/v1/otto/drafts', cookieA, {
        kind: 'draft',
        contactId: ct,
        channel: 'whatsapp',
        instruction: 'Ask about Friday',
      }),
    );
    expect(wa).toMatchObject({ kind: 'draft', channel: 'whatsapp' });
    expect(wa.text.startsWith('Hi Jonas,')).toBe(true);
    const sms = await data<Draft>(
      await post('/api/v1/otto/drafts', cookieA, { kind: 'draft', contactId: ct }),
    );
    expect(sms.channel).toBe('sms');
    const brief = await data<Draft>(
      await post('/api/v1/otto/drafts', cookieA, {
        kind: 'brief',
        contactId: ct,
        channel: 'whatsapp',
      }),
    );
    expect(brief.channel).toBeNull();
  });

  it('answers 404 with an audit for another org contact, 422 for archived, 400 for NUL', async () => {
    const ct = await newContact(cookieA, 'Hidden Person');
    const r = await post('/api/v1/otto/drafts', cookieB, { kind: 'brief', contactId: ct });
    expect(r.status).toBe(404);
    const audits = await withAppDb((db) =>
      withTenant(db, orgB, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.entityId, ct), eq(auditEvent.outcome, 'not_found'))),
      ),
    );
    expect(audits.length).toBeGreaterThan(0);
    const draftsA = await withAppDb((db) =>
      withTenant(db, orgA, (tx) => tx.select().from(ottoDraft).where(eq(ottoDraft.contactId, ct))),
    );
    expect(draftsA).toHaveLength(0);

    const archived = await newContact(cookieA, 'Old Contact');
    const del = await post(`/api/v1/contacts/${archived}/archive`, cookieA, {});
    expect(del.status).toBeLessThan(300);
    const r2 = await post('/api/v1/otto/drafts', cookieA, { kind: 'brief', contactId: archived });
    expect(r2.status).toBe(422);

    const r3 = await post('/api/v1/otto/drafts', cookieA, {
      kind: 'draft',
      contactId: ct,
      instruction: 'bad\u0000text',
    });
    expect(r3.status).toBe(400);
  });
});

describe('POST /api/v1/otto/digest', () => {
  it("cites a teammate's note, then reports all caught up without a new usage row", async () => {
    const cookie = await signUp(uniqueEmail('otto-c'), 'Otto C');
    const { orgId, userId } = await meOf(cookie);
    const ct = await newContact(cookie, 'Digest Contact');
    const mateId = `mate-${crypto.randomUUID().slice(0, 8)}`;
    await withAdminDb(async (db) => {
      await db
        .insert(user)
        .values({ id: mateId, name: 'Mate', email: `${mateId}@example.test`, emailVerified: true });
      await db.insert(member).values({
        id: `m-${mateId}`,
        organizationId: orgId,
        userId: mateId,
        createdAt: new Date(),
      });
    });
    const ownNoteId = await addNote(cookie, ct, 'My own note');
    const noteId = await withAppDb((db) =>
      withTenant(db, orgId, async (tx) => {
        const [row] = await tx
          .insert(timelineEvent)
          .values({
            organizationId: orgId,
            contactId: ct,
            kind: 'note',
            title: 'Note',
            body: 'Asked to move the call',
            actorUserId: mateId,
            source: 'app',
          })
          .returning({ id: timelineEvent.id });
        return row?.id ?? '';
      }),
    );
    const first = await data<Draft>(await post('/api/v1/otto/digest', cookie, {}));
    expect(first.kind).toBe('digest');
    expect(first.contactId).toBeNull();
    expect(first.citations.map((c) => c.ref)).toContain(noteId);
    expect(first.text).toContain('Asked to move the call');
    expect(first.citations.map((c) => c.ref)).not.toContain(ownNoteId);
    expect(first.text).not.toContain('My own note');
    expect(await usageRows(orgId, userId)).toHaveLength(1);

    const second = await data<Draft>(await post('/api/v1/otto/digest', cookie, {}));
    expect(second.text).toBe("You're all caught up.");
    expect(second.citations).toEqual([]);
    expect(second.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await usageRows(orgId, userId)).toHaveLength(1);
  });
});

describe('daily quota', () => {
  it('cannot be raced past the limit by concurrent requests', async () => {
    const cookie = await signUp(uniqueEmail('otto-r'), 'Otto R');
    const { orgId, userId } = await meOf(cookie);
    const ct = await newContact(cookie, 'Race Contact');
    await withAdminDb((db) =>
      db.insert(usageEvent).values(
        Array.from({ length: 48 }, (_, i) => ({
          organizationId: orgId,
          userId,
          service: 'ai' as const,
          quantity: 1,
          unit: 'tokens',
          provider: 'mock',
          idempotencyKey: `seed:${i}`,
        })),
      ),
    );
    const responses = await Promise.all(
      [0, 1, 2].map(() => post('/api/v1/otto/drafts', cookie, { kind: 'brief', contactId: ct })),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 429]);
    expect(await usageRows(orgId, userId)).toHaveLength(50);
  });

  it('refuses the 51st request of a UTC day with 429 and writes nothing', async () => {
    const cookie = await signUp(uniqueEmail('otto-q'), 'Otto Q');
    const { orgId, userId } = await meOf(cookie);
    const ct = await newContact(cookie, 'Quota Contact');
    await withAdminDb((db) =>
      db.insert(usageEvent).values(
        Array.from({ length: 50 }, (_, i) => ({
          organizationId: orgId,
          userId,
          service: 'ai' as const,
          quantity: 1,
          unit: 'tokens',
          provider: 'mock',
          idempotencyKey: `seed:${i}`,
        })),
      ),
    );
    const r = await post('/api/v1/otto/drafts', cookie, { kind: 'brief', contactId: ct });
    expect(r.status).toBe(429);
    const body = (await r.json()) as Envelope<never>;
    expect(body.error).toEqual({
      code: 'quota_exceeded',
      message: "Otto has reached today's limit of 50 requests.",
    });
    expect(await usageRows(orgId, userId)).toHaveLength(50);
    const drafts = await withAppDb((db) =>
      withTenant(db, orgId, (tx) => tx.select().from(ottoDraft)),
    );
    expect(drafts).toHaveLength(0);
  });
});

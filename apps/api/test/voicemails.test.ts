import { newId } from '@knoqra/core';
import { auditEvent, call, voicemail, withTenant } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type VoicemailJson = {
  id: string;
  callId: string;
  contact: { id: string; displayName: string } | null;
  fromE164: string;
  durationSeconds: number;
  transcript: string | null;
  listenedAt: string | null;
  createdAt: string;
};
type User = { cookie: string; orgId: string; userId: string };

async function newUser(label: string): Promise<User> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  return { cookie, orgId, userId };
}

/** An inbound call with a voicemail left on it, written by the admin role (a fixture). */
async function seedVoicemail(
  u: User,
  options: { contactId?: string; createdAt?: Date; transcript?: string | null } = {},
): Promise<{ id: string; callId: string }> {
  const callId = newId('cl');
  const id = newId('vm');
  await withAdminDb(async (db) => {
    await db.insert(call).values({
      id: callId,
      organizationId: u.orgId,
      userId: u.userId,
      contactId: options.contactId ?? null,
      direction: 'inbound',
      state: 'completed',
      fromE164: '+12025550177',
      toE164: '+12025550100',
      provider: 'fake',
      clientState: crypto.randomUUID().replaceAll('-', ''),
    });
    await db.insert(voicemail).values({
      id,
      organizationId: u.orgId,
      callId,
      contactId: options.contactId ?? null,
      fromE164: '+12025550177',
      durationSeconds: 12,
      transcript: options.transcript === undefined ? 'Call me back.' : options.transcript,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
  });
  return { id, callId };
}

async function newContact(u: User, name: string): Promise<string> {
  const r = await post('/api/v1/contacts', u.cookie, { displayName: name, phone: '+12025550177' });
  return ((await r.json()) as Envelope<{ id: string }>).data?.id as string;
}

async function listed(u: User): Promise<VoicemailJson[]> {
  const r = await get('/api/v1/voicemails', u.cookie);
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<{ items: VoicemailJson[] }>).data?.items ?? [];
}

const listen = (u: User, id: string) => post(`/api/v1/voicemails/${id}/listened`, u.cookie, {});

describe('GET /api/v1/voicemails', () => {
  it('requires a session', async () => {
    expect((await get('/api/v1/voicemails')).status).toBe(401);
  });

  it('lists newest first with the contact and the item shape', async () => {
    const u = await newUser('vm-list');
    const contactId = await newContact(u, 'Ada Caller');
    const older = await seedVoicemail(u, { createdAt: new Date('2026-01-01T10:00:00Z') });
    const newer = await seedVoicemail(u, {
      contactId,
      createdAt: new Date('2026-01-02T10:00:00Z'),
    });
    const items = await listed(u);
    expect(items.map((i) => i.id)).toEqual([newer.id, older.id]);
    expect(items[0]).toEqual({
      id: newer.id,
      callId: newer.callId,
      contact: { id: contactId, displayName: 'Ada Caller' },
      fromE164: '+12025550177',
      durationSeconds: 12,
      transcript: 'Call me back.',
      listenedAt: null,
      createdAt: '2026-01-02T10:00:00.000Z',
    });
    expect(items[1]?.contact).toBeNull();
  });

  it('never lists another organization voicemails', async () => {
    const a = await newUser('vm-iso-a');
    const b = await newUser('vm-iso-b');
    await seedVoicemail(a);
    expect(await listed(b)).toEqual([]);
  });
});

describe('POST /api/v1/voicemails/{id}/listened', () => {
  it('marks listened, is idempotent and audits', async () => {
    const u = await newUser('vm-listened');
    const { id } = await seedVoicemail(u);
    const first = await listen(u, id);
    expect(first.status).toBe(200);
    const firstAt = ((await first.json()) as Envelope<VoicemailJson>).data?.listenedAt;
    expect(firstAt).toEqual(expect.any(String));
    const second = await listen(u, id);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Envelope<VoicemailJson>).data?.listenedAt).toBe(firstAt);
    const audits = await withAppDb((db) =>
      withTenant(db, u.orgId, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.entityId, id), eq(auditEvent.action, 'voicemail.listened'))),
      ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain('+1202');
  });

  it('is 404 for another organization and for a malformed id', async () => {
    const a = await newUser('vm-404-a');
    const b = await newUser('vm-404-b');
    const { id } = await seedVoicemail(a);
    const cross = await listen(b, id);
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as Envelope<unknown>).error?.code).toBe('not_found');
    expect((await listen(a, 'vm_nope')).status).toBe(404);
    expect((await listed(a))[0]?.listenedAt).toBeNull();
  });
});

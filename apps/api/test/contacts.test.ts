import { auditEvent, withTenant } from '@knoqra/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post, signUp, uniqueEmail, withAppDb } from './helpers';

type Contact = {
  id: string;
  organizationId: string;
  displayName: string;
  company: string | null;
  phoneE164: string;
  timezone: string | null;
  source: string;
  email: string | null;
  jobTitle: string | null;
  tags: string[];
  sourceDetail: string | null;
  archivedAt: string | null;
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
};
type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

let cookieA: string;
let cookieB: string;
let orgA: string;
let orgB: string;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

/** Audit rows as the app role inside the tenant's own RLS context. */
function auditsOf(orgId: string) {
  return withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));
}

async function createContact(cookie: string, body: Record<string, unknown>): Promise<Contact> {
  const r = await post('/api/v1/contacts', cookie, body);
  const json = (await r.json()) as Envelope<Contact>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data;
}

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('owner-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('owner-b'), 'Owner B');
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

describe('POST /api/v1/contacts', () => {
  it('creates a contact with normalized phone and audits it', async () => {
    const r = await post('/api/v1/contacts', cookieA, {
      displayName: 'Maya',
      phone: '(202) 555-0123',
      company: 'Acme',
      timezone: 'America/New_York',
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as Envelope<Contact>;
    expect(body.error).toBeNull();
    expect(body.data).toEqual({
      id: expect.stringMatching(/^ct_[0-9a-f]{32}$/),
      organizationId: orgA,
      displayName: 'Maya',
      company: 'Acme',
      phoneE164: '+12025550123',
      timezone: 'America/New_York',
      source: 'manual',
      email: null,
      jobTitle: null,
      tags: [],
      sourceDetail: null,
      archivedAt: null,
      mergedIntoId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(new Date(body.data?.createdAt ?? '').toISOString()).toBe(body.data?.createdAt);

    const audits = (await auditsOf(orgA)).filter((e) => e.entityId === body.data?.id);
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: orgA,
        action: 'contact.create',
        entityType: 'contact',
        outcome: 'allowed',
        actorUserId: expect.any(String),
      }),
    ]);
  });

  it('stores null for omitted optional fields', async () => {
    const data = await createContact(cookieA, {
      displayName: 'No Extras',
      phone: '+1 202 555 0125',
    });
    expect(data).toMatchObject({ company: null, timezone: null, phoneE164: '+12025550125' });
  });

  it.each(['', '12', 'call me'])('422 invalid_phone for %j', async (phone) => {
    const r = await post('/api/v1/contacts', cookieA, { displayName: 'X', phone });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'invalid_phone', message: expect.any(String) },
    });
  });

  it('409 duplicate_contact for the same phone in one org', async () => {
    await createContact(cookieA, { displayName: 'Dup One', phone: '+12025550126' });
    const second = await post('/api/v1/contacts', cookieA, {
      displayName: 'Dup Two',
      phone: '(202) 555-0126',
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      data: null,
      error: { code: 'duplicate_contact', message: expect.any(String) },
    });
    const denied = (await auditsOf(orgA)).filter(
      (e) => e.action === 'contact.create' && e.metadata.reason === 'duplicate_contact',
    );
    expect(denied).toEqual([expect.objectContaining({ outcome: 'denied', entityId: null })]);
  });

  it('the same phone may exist in two different orgs', async () => {
    const a = await post('/api/v1/contacts', cookieA, {
      displayName: 'Shared',
      phone: '+12025550127',
    });
    const b = await post('/api/v1/contacts', cookieB, {
      displayName: 'Shared',
      phone: '+12025550127',
    });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it.each([
    ['a missing displayName', { phone: '+12025550128' }],
    ['an empty displayName', { displayName: '', phone: '+12025550128' }],
    ['a 121-character displayName', { displayName: 'x'.repeat(121), phone: '+12025550128' }],
    ['a non-string phone', { displayName: 'X', phone: 2025550128 }],
    ['an unknown timezone', { displayName: 'X', phone: '+12025550128', timezone: 'Mars/Base' }],
  ])('400 validation_error for %s', async (_, body) => {
    const r = await post('/api/v1/contacts', cookieA, body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'validation_error', message: expect.any(String) },
    });
  });

  it('400 validation_error for a body that is not JSON', async () => {
    const r = await post('/api/v1/contacts', cookieA, undefined);
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('validation_error');
  });

  it('401 without a session', async () => {
    const r = await post('/api/v1/contacts', '', { displayName: 'X', phone: '+12025550129' });
    expect(r.status).toBe(401);
  });
});

describe('GET /api/v1/contacts', () => {
  it("lists only the caller's contacts, ordered by display name", async () => {
    const cookieC = await signUp(uniqueEmail('owner-c'), 'Owner C');
    await createContact(cookieC, { displayName: 'Zed', phone: '+12025550131' });
    await createContact(cookieC, { displayName: 'Amy', phone: '+12025550132' });
    await createContact(cookieC, { displayName: 'Mia', phone: '+12025550133' });
    const r = await get('/api/v1/contacts', cookieC);
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as Envelope<{ items: Contact[]; nextCursor: string | null }>;
    expect(data?.items.map((c) => c.displayName)).toEqual(['Amy', 'Mia', 'Zed']);
    expect(data?.nextCursor).toBeNull();
  });

  it('401 without a session', async () => {
    expect((await get('/api/v1/contacts')).status).toBe(401);
  });
});

describe('GET /api/v1/contacts/{id}', () => {
  it('returns the contact to its own organization', async () => {
    const created = await createContact(cookieA, { displayName: 'Own', phone: '+12025550134' });
    const r = await get(`/api/v1/contacts/${created.id}`, cookieA);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Contact>).data).toEqual(created);
  });

  it("org B cannot read org A's contact and the attempt is audited", async () => {
    const { id } = await createContact(cookieA, { displayName: 'Maya', phone: '+12025550124' });

    const r = await get(`/api/v1/contacts/${id}`, cookieB);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'not_found', message: expect.any(String) },
    });

    const seenByB = (await auditsOf(orgB)).filter(
      (e) => e.action === 'contact.read' && e.entityId === id,
    );
    expect(seenByB).toEqual([
      expect.objectContaining({
        organizationId: orgB,
        action: 'contact.read',
        entityType: 'contact',
        entityId: id,
        outcome: 'not_found',
        actorUserId: expect.any(String),
      }),
    ]);
    const seenByA = (await auditsOf(orgA)).filter(
      (e) => e.action === 'contact.read' && e.entityId === id,
    );
    expect(seenByA).toEqual([]);
  });

  it('404 for an id that does not exist, audited for the requester', async () => {
    const id = `ct_${crypto.randomUUID().replaceAll('-', '')}`;
    const r = await get(`/api/v1/contacts/${id}`, cookieA);
    expect(r.status).toBe(404);
    const audits = (await auditsOf(orgA)).filter((e) => e.entityId === id);
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: orgA,
        action: 'contact.read',
        outcome: 'not_found',
        actorUserId: expect.any(String),
      }),
    ]);
  });
});

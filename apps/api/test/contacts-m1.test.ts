import { auditEvent, contact, timelineEvent, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Contact = {
  id: string;
  displayName: string;
  company: string | null;
  phoneE164: string;
  email: string | null;
  jobTitle: string | null;
  timezone: string | null;
  tags: string[];
  archivedAt: string | null;
  mergedIntoId: string | null;
};
type Page = { items: Contact[]; nextCursor: string | null };
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

const auditsOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));
const timelineOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(timelineEvent)));

async function create(cookie: string, body: Record<string, unknown>): Promise<Contact> {
  const r = await post('/api/v1/contacts', cookie, body);
  const json = (await r.json()) as Envelope<Contact>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data;
}

function patch(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

const list = (cookie: string, query = '') => get(`/api/v1/contacts${query}`, cookie);

async function page(cookie: string, query = ''): Promise<Page> {
  const r = await list(cookie, query);
  expect(r.status).toBe(200);
  const json = (await r.json()) as Envelope<Page>;
  if (!json.data) throw new Error('no data');
  return json.data;
}

let seq = 0;
const phone = (n: number) => `+1202555${String(n).padStart(4, '0')}`;
const b64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('m1-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('m1-b'), 'Owner B');
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

describe('GET /api/v1/contacts pagination', () => {
  it('pages 120 contacts as 50/50/20 with no duplicates or gaps', async () => {
    const cookie = await signUp(uniqueEmail('m1-page'), 'Pager');
    const org = await orgOf(cookie);
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `ct_${crypto.randomUUID().replaceAll('-', '')}`,
      organizationId: org,
      // Repeated names exercise the id tiebreak; mixed case exercises lower().
      displayName: `${i % 2 ? 'Pat' : 'pat'} ${String(Math.floor(i / 3)).padStart(3, '0')}`,
      phoneE164: phone(1000 + i),
    }));
    await withAdminDb((db) => db.insert(contact).values(rows));

    const p1 = await page(cookie);
    expect(p1.items).toHaveLength(50);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = await page(cookie, `?cursor=${p1.nextCursor}`);
    expect(p2.items).toHaveLength(50);
    expect(p2.nextCursor).toEqual(expect.any(String));
    const p3 = await page(cookie, `?cursor=${p2.nextCursor}`);
    expect(p3.items).toHaveLength(20);
    expect(p3.nextCursor).toBeNull();

    const all = [...p1.items, ...p2.items, ...p3.items];
    expect(new Set(all.map((c) => c.id))).toEqual(new Set(rows.map((r) => r.id)));
    expect(all).toHaveLength(120);
    const keys = all.map((c) => `${c.displayName.toLowerCase()}|${c.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('honours limit; no cursor when exactly limit rows remain', async () => {
    const cookie = await signUp(uniqueEmail('m1-limit'), 'Limit');
    await create(cookie, { displayName: 'One', phone: phone(2001) });
    await create(cookie, { displayName: 'Two', phone: phone(2002) });
    const exact = await page(cookie, '?limit=2');
    expect(exact.items).toHaveLength(2);
    expect(exact.nextCursor).toBeNull();
    const first = await page(cookie, '?limit=1');
    expect(first.nextCursor).not.toBeNull();
  });

  it.each(['?limit=500', '?limit=0', '?limit=abc'])('400 for %s', async (q) => {
    const r = await list(cookieA, q);
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Page>).error?.code).toBe('validation_error');
  });

  it.each([
    ['garbage', 'not-a-cursor!!'],
    ['base64url of {"x":1}', b64url('{"x":1}')],
    ['base64url of non-JSON text', b64url('hello')],
  ])('400 validation_error "Invalid cursor" for a %s cursor', async (_, cursor) => {
    const r = await list(cookieA, `?cursor=${encodeURIComponent(cursor)}`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'validation_error', message: 'Invalid cursor' },
    });
  });
});

describe('GET /api/v1/contacts search and archive filter', () => {
  it('finds by name, company, email and phone digits, and escapes LIKE wildcards', async () => {
    const cookie = await signUp(uniqueEmail('m1-search'), 'Searcher');
    await create(cookie, {
      displayName: 'Zelda Quill',
      phone: phone(3001),
      company: 'Hyrule Labs',
      email: 'zq@example.test',
    });
    await create(cookie, { displayName: 'Other', phone: phone(3002), company: '100% Pure' });
    const names = async (q: string) =>
      (await page(cookie, `?q=${encodeURIComponent(q)}`)).items.map((c) => c.displayName);

    expect(await names('zelda')).toEqual(['Zelda Quill']);
    expect(await names('hyrule')).toEqual(['Zelda Quill']);
    expect(await names('ZQ@EXAMPLE')).toEqual(['Zelda Quill']);
    expect(await names('555 3001')).toEqual(['Zelda Quill']);
    expect(await names('(202) 555-3001')).toEqual(['Zelda Quill']);
    expect(await names('100%')).toEqual(['Other']);
    expect(await names('%')).toEqual(['Other']);
    expect(await names('_')).toEqual([]);
  });

  it('400 for a q longer than 100 characters', async () => {
    expect((await list(cookieA, `?q=${'a'.repeat(101)}`)).status).toBe(400);
  });

  it('hides archived contacts by default and shows them with archived=true', async () => {
    const cookie = await signUp(uniqueEmail('m1-arch'), 'Archiver');
    const keep = await create(cookie, { displayName: 'Keep', phone: phone(4001) });
    const gone = await create(cookie, { displayName: 'Gone', phone: phone(4002) });
    const r = await post(`/api/v1/contacts/${gone.id}/archive`, cookie, {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<Contact>).data?.archivedAt).toEqual(expect.any(String));

    expect((await page(cookie)).items.map((c) => c.id)).toEqual([keep.id]);
    expect((await page(cookie, '?archived=true')).items.map((c) => c.id)).toEqual([gone.id]);
  });

  it('treats merged contacts as archived and refuses to restore them', async () => {
    const cookie = await signUp(uniqueEmail('m1-merged'), 'Merger');
    const target = await create(cookie, { displayName: 'Target', phone: phone(5001) });
    const source = await create(cookie, { displayName: 'Source', phone: phone(5002) });
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: target.id, archivedAt: new Date() })
        .where(eq(contact.id, source.id)),
    );
    expect((await page(cookie)).items.map((c) => c.id)).toEqual([target.id]);
    expect((await page(cookie, '?archived=true')).items.map((c) => c.id)).toEqual([source.id]);
    const restore = await post(`/api/v1/contacts/${source.id}/restore`, cookie, {});
    expect(restore.status).toBe(422);
    expect(await restore.json()).toEqual({
      data: null,
      error: { code: 'validation_error', message: 'Merged contacts cannot be restored' },
    });
  });
});

describe('POST /api/v1/contacts with new fields', () => {
  it('accepts email, jobTitle and tags (trimmed, deduped)', async () => {
    const c = await create(cookieA, {
      displayName: 'Rich',
      phone: phone(6001),
      email: 'rich@example.test',
      jobTitle: 'CTO',
      tags: ['vip', 'vip', ' beta '],
    });
    expect(c).toMatchObject({ email: 'rich@example.test', jobTitle: 'CTO', tags: ['vip', 'beta'] });
  });

  it('400 for an invalid email', async () => {
    const r = await post('/api/v1/contacts', cookieA, {
      displayName: 'Bad',
      phone: phone(6002),
      email: 'nope',
    });
    expect(r.status).toBe(400);
  });
});

describe('PATCH /api/v1/contacts/{id}', () => {
  it('updates fields, normalizes phone, audits field names and writes a timeline event', async () => {
    const c = await create(cookieA, { displayName: 'Edit Me', phone: phone(7001) });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, {
      displayName: 'Edited',
      phone: '(202) 555-7101',
      company: 'NewCo',
      email: 'edited@example.test',
      jobTitle: 'Lead',
      timezone: 'Europe/London',
      tags: ['a', 'b', 'a'],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Envelope<Contact>;
    expect(body.data).toMatchObject({
      id: c.id,
      displayName: 'Edited',
      phoneE164: '+12025557101',
      company: 'NewCo',
      email: 'edited@example.test',
      jobTitle: 'Lead',
      timezone: 'Europe/London',
      tags: ['a', 'b'],
    });

    const audits = (await auditsOf(orgA)).filter(
      (e) => e.entityId === c.id && e.action === 'contact.update',
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: 'allowed' });
    const fields = (audits[0]?.metadata as { fields: string[] } | undefined)?.fields ?? [];
    expect([...fields].sort()).toEqual(
      ['company', 'displayName', 'email', 'jobTitle', 'phone', 'tags', 'timezone'].sort(),
    );
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain('edited@example.test');

    const events = (await timelineOf(orgA)).filter((e) => e.contactId === c.id);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'system',
        title: 'Contact details updated',
        source: 'app',
        actorUserId: expect.any(String),
      }),
    ]);
  });

  it('records only the fields that actually changed', async () => {
    const c = await create(cookieA, { displayName: 'Same', phone: phone(7002), company: 'Co' });
    await patch(`/api/v1/contacts/${c.id}`, cookieA, { displayName: 'Same', company: 'Other' });
    const audit = (await auditsOf(orgA)).find(
      (e) => e.entityId === c.id && e.action === 'contact.update',
    );
    expect((audit?.metadata as { fields?: string[] } | undefined)?.fields).toEqual(['company']);
  });

  it('allows clearing nullable fields with null', async () => {
    const c = await create(cookieA, { displayName: 'Clear', phone: phone(7003), company: 'Co' });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, { company: null });
    expect(((await r.json()) as Envelope<Contact>).data?.company).toBeNull();
  });

  it('409 duplicate_contact for a phone already used in the org', async () => {
    await create(cookieA, { displayName: 'Taken', phone: phone(7010) });
    const c = await create(cookieA, { displayName: 'Mover', phone: phone(7011) });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, { phone: phone(7010) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('duplicate_contact');
    expect((await timelineOf(orgA)).filter((e) => e.contactId === c.id)).toEqual([]);
  });

  it('422 invalid_phone', async () => {
    const c = await create(cookieA, { displayName: 'BadPhone', phone: phone(7012) });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, { phone: 'call me' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('invalid_phone');
  });

  it.each([
    ['a bad timezone', { timezone: 'Mars/Base' }],
    ['an offset timezone', { timezone: '+05:00' }],
    ['a bad email', { email: 'nope' }],
    ['an empty body', {}],
    ['an empty displayName', { displayName: '' }],
    ['an empty tag', { tags: [''] }],
    ['a 41-char tag', { tags: ['x'.repeat(41)] }],
    ['21 tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
  ])('400 validation_error for %s', async (_, body) => {
    const c = await create(cookieA, { displayName: 'Validate', phone: phone(7200 + seq++) });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('validation_error');
  });

  it('404 for an unknown id', async () => {
    const r = await patch('/api/v1/contacts/ct_missing', cookieA, { company: 'X' });
    expect(r.status).toBe(404);
  });

  it("org B gets 404 on PATCH of org A's contact, is audited, and the row is unchanged", async () => {
    const c = await create(cookieA, { displayName: 'Private', phone: phone(7500), company: 'A' });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieB, { company: 'Hacked' });
    expect(r.status).toBe(404);
    const seenByB = (await auditsOf(orgB)).filter(
      (e) => e.entityId === c.id && e.action === 'contact.update',
    );
    expect(seenByB).toEqual([
      expect.objectContaining({ organizationId: orgB, outcome: 'not_found' }),
    ]);
    expect(
      (await auditsOf(orgA)).filter((e) => e.entityId === c.id && e.action === 'contact.update'),
    ).toEqual([]);
    const after = (await (
      await get(`/api/v1/contacts/${c.id}`, cookieA)
    ).json()) as Envelope<Contact>;
    expect(after.data?.company).toBe('A');
    expect((await timelineOf(orgA)).filter((e) => e.contactId === c.id)).toEqual([]);
  });

  it('401 without a session', async () => {
    expect((await patch('/api/v1/contacts/ct_x', '', { company: 'X' })).status).toBe(401);
  });
});

describe('POST /api/v1/contacts/{id}/archive and /restore', () => {
  it('archives, audits and writes one timeline event; repeating is idempotent', async () => {
    const c = await create(cookieA, { displayName: 'Arch', phone: phone(8001) });
    const first = await post(`/api/v1/contacts/${c.id}/archive`, cookieA, {});
    expect(first.status).toBe(200);
    const archivedAt = ((await first.json()) as Envelope<Contact>).data?.archivedAt;
    expect(archivedAt).toEqual(expect.any(String));

    const second = await post(`/api/v1/contacts/${c.id}/archive`, cookieA, {});
    expect(second.status).toBe(200);
    expect(((await second.json()) as Envelope<Contact>).data?.archivedAt).toBe(archivedAt);

    const audits = (await auditsOf(orgA)).filter(
      (e) => e.entityId === c.id && e.action === 'contact.archive',
    );
    expect(audits).toHaveLength(1);
    const events = (await timelineOf(orgA)).filter((e) => e.contactId === c.id);
    expect(events).toEqual([
      expect.objectContaining({ kind: 'system', title: 'Contact archived', source: 'app' }),
    ]);
  });

  it('restores, and repeating restore is idempotent', async () => {
    const c = await create(cookieA, { displayName: 'Rest', phone: phone(8002) });
    await post(`/api/v1/contacts/${c.id}/archive`, cookieA, {});
    const first = await post(`/api/v1/contacts/${c.id}/restore`, cookieA, {});
    expect(first.status).toBe(200);
    expect(((await first.json()) as Envelope<Contact>).data?.archivedAt).toBeNull();
    const second = await post(`/api/v1/contacts/${c.id}/restore`, cookieA, {});
    expect(second.status).toBe(200);

    const restores = (await auditsOf(orgA)).filter(
      (e) => e.entityId === c.id && e.action === 'contact.restore',
    );
    expect(restores).toHaveLength(1);
    const titles = (await timelineOf(orgA))
      .filter((e) => e.contactId === c.id)
      .map((e) => e.title)
      .sort();
    expect(titles).toEqual(['Contact archived', 'Contact restored']);
  });

  it.each(['archive', 'restore'])(
    "org B gets 404 on %s of org A's contact, audited for B only",
    async (verb) => {
      const c = await create(cookieA, {
        displayName: 'Guarded',
        phone: phone(8100 + (verb === 'archive' ? 0 : 1)),
      });
      const r = await post(`/api/v1/contacts/${c.id}/${verb}`, cookieB, {});
      expect(r.status).toBe(404);
      const action = `contact.${verb}`;
      expect(
        (await auditsOf(orgB)).filter((e) => e.entityId === c.id && e.action === action),
      ).toEqual([expect.objectContaining({ organizationId: orgB, outcome: 'not_found' })]);
      expect(
        (await auditsOf(orgA)).filter((e) => e.entityId === c.id && e.action === action),
      ).toEqual([]);
      const after = (await (
        await get(`/api/v1/contacts/${c.id}`, cookieA)
      ).json()) as Envelope<Contact>;
      expect(after.data?.archivedAt).toBeNull();
    },
  );
});

describe('fix round 1: NUL bytes and cursor size', () => {
  it('400 for a cursor whose n or i holds a NUL', async () => {
    for (const payload of ['{"n":"\\u0000","i":"x"}', '{"n":"a","i":"\\u0000"}']) {
      const r = await list(cookieA, `?cursor=${b64url(payload)}`);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        data: null,
        error: { code: 'validation_error', message: 'Invalid cursor' },
      });
    }
  });

  it('400 for a q holding a NUL', async () => {
    const r = await list(cookieA, '?q=%00');
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Page>).error?.code).toBe('validation_error');
  });

  it('paginates names of about 150 CJK characters', async () => {
    const cookie = await signUp(uniqueEmail('m1-cjk'), 'Cjk');
    const org = await orgOf(cookie);
    const rows = ['一', '二', '三'].map((tail, i) => ({
      id: `ct_${crypto.randomUUID().replaceAll('-', '')}`,
      organizationId: org,
      displayName: `${'漢'.repeat(150)}${tail}`,
      phoneE164: phone(9300 + i),
    }));
    await withAdminDb((db) => db.insert(contact).values(rows));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await page(cookie, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...p.items.map((c) => c.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
    expect(seen).toHaveLength(3);
  });
});

describe('fix round 1: duplicate hints, merged edits, blanks', () => {
  async function archivedHolder(cookie: string, n: number): Promise<Contact> {
    const holder = await create(cookie, { displayName: `Holder ${n}`, phone: phone(n) });
    await post(`/api/v1/contacts/${holder.id}/archive`, cookie, {});
    return holder;
  }

  it('create: 409 mentions an archived holder', async () => {
    await archivedHolder(cookieA, 9401);
    const r = await post('/api/v1/contacts', cookieA, { displayName: 'New', phone: phone(9401) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      data: null,
      error: {
        code: 'duplicate_contact',
        message: 'This number belongs to an archived contact. Restore it instead.',
      },
    });
  });

  it('PATCH: 409 mentions an archived holder or keeps the default; a merged holder frees it', async () => {
    const mover = await create(cookieA, { displayName: 'Mover', phone: phone(9410) });
    await archivedHolder(cookieA, 9411);
    const merged = await create(cookieA, { displayName: 'Merged', phone: phone(9412) });
    const active = await create(cookieA, { displayName: 'Active', phone: phone(9413) });
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: active.id, archivedAt: new Date() })
        .where(eq(contact.id, merged.id)),
    );
    const message = async (n: number) => {
      const r = await patch(`/api/v1/contacts/${mover.id}`, cookieA, { phone: phone(n) });
      expect(r.status).toBe(409);
      return ((await r.json()) as Envelope<Contact>).error?.message;
    };
    expect(await message(9411)).toBe(
      'This number belongs to an archived contact. Restore it instead.',
    );
    expect(await message(9413)).toBe('A contact with this phone number already exists.');
    const takeMerged = await patch(`/api/v1/contacts/${mover.id}`, cookieA, { phone: phone(9412) });
    expect(takeMerged.status).toBe(200);
  });

  it('PATCH on a merged contact is 422 and audited as denied', async () => {
    const target = await create(cookieA, { displayName: 'Tgt', phone: phone(9420) });
    const source = await create(cookieA, { displayName: 'Src', phone: phone(9421) });
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: target.id, archivedAt: new Date() })
        .where(eq(contact.id, source.id)),
    );
    const r = await patch(`/api/v1/contacts/${source.id}`, cookieA, { company: 'X' });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({
      data: null,
      error: { code: 'validation_error', message: 'Merged contacts cannot be edited' },
    });
    const audits = (await auditsOf(orgA)).filter(
      (e) => e.entityId === source.id && e.action === 'contact.update',
    );
    expect(audits).toEqual([
      expect.objectContaining({ outcome: 'denied', metadata: { reason: 'merged' } }),
    ]);
  });

  it('create stores blank company, email and jobTitle as null', async () => {
    const c = await create(cookieA, {
      displayName: 'Blanks',
      phone: phone(9430),
      company: '   ',
      email: ' ',
      jobTitle: '',
    });
    expect(c).toMatchObject({ company: null, email: null, jobTitle: null });
  });

  it('a no-op PATCH returns 200 with no audit or timeline row', async () => {
    const c = await create(cookieA, { displayName: 'Noop', phone: phone(9440), company: 'Co' });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, {
      displayName: 'Noop',
      company: 'Co',
      phone: phone(9440),
    });
    expect(r.status).toBe(200);
    expect(
      (await auditsOf(orgA)).filter((e) => e.entityId === c.id && e.action === 'contact.update'),
    ).toEqual([]);
    expect((await timelineOf(orgA)).filter((e) => e.contactId === c.id)).toEqual([]);
  });

  it('q combines with archived=true', async () => {
    const cookie = await signUp(uniqueEmail('m1-qarch'), 'Qarch');
    const a = await create(cookie, { displayName: 'Walnut Old', phone: phone(9450) });
    await create(cookie, { displayName: 'Walnut Live', phone: phone(9451) });
    const b = await create(cookie, { displayName: 'Other Old', phone: phone(9452) });
    await post(`/api/v1/contacts/${a.id}/archive`, cookie, {});
    await post(`/api/v1/contacts/${b.id}/archive`, cookie, {});
    const ids = (await page(cookie, '?q=walnut&archived=true')).items.map((c) => c.id);
    expect(ids).toEqual([a.id]);
  });

  it('restoring a merged contact writes a denied audit row and no timeline event', async () => {
    const target = await create(cookieA, { displayName: 'RT', phone: phone(9460) });
    const source = await create(cookieA, { displayName: 'RS', phone: phone(9461) });
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: target.id, archivedAt: new Date() })
        .where(eq(contact.id, source.id)),
    );
    expect((await post(`/api/v1/contacts/${source.id}/restore`, cookieA, {})).status).toBe(422);
    expect(
      (await auditsOf(orgA)).filter(
        (e) => e.entityId === source.id && e.action === 'contact.restore',
      ),
    ).toEqual([expect.objectContaining({ outcome: 'denied', metadata: { reason: 'merged' } })]);
    expect((await timelineOf(orgA)).filter((e) => e.contactId === source.id)).toEqual([]);
  });
});

describe('fix round 2: control characters in text fields', () => {
  const base = (n: number) => ({ displayName: 'Ctl', phone: phone(n) });
  const fields: Array<[string, Record<string, unknown>]> = [
    ['displayName', { displayName: 'a\u0000b' }],
    ['phone', { phone: '+1202555\u00000100' }],
    ['company', { company: 'a\u0000b' }],
    ['email', { email: 'a\u0000b@example.test' }],
    ['jobTitle', { jobTitle: 'a\u0000b' }],
    ['timezone', { timezone: 'Europe/\u0000London' }],
    ['a tag', { tags: ['ok', 'a\u0000b'] }],
    ['displayName with U+0007', { displayName: 'a\u0007b' }],
  ];

  it.each(fields)('create: 400 validation_error for NUL in %s', async (_, patchBody) => {
    const r = await post('/api/v1/contacts', cookieA, { ...base(9500), ...patchBody });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('validation_error');
  });

  it.each(fields)('PATCH: 400 validation_error for NUL in %s', async (_, body) => {
    const c = await create(cookieA, { displayName: 'Ctl Patch', phone: phone(9600 + seq++) });
    const r = await patch(`/api/v1/contacts/${c.id}`, cookieA, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<Contact>).error?.code).toBe('validation_error');
  });

  it('accepts multilingual names with emoji, tabs and newlines in text', async () => {
    const c = await create(cookieA, {
      displayName: 'Zoë 李雷 🎉 Müller',
      phone: phone(9700),
      company: 'Société\tGénérale\nParis',
      tags: ['日本語', '🔥'],
    });
    expect(c).toMatchObject({ displayName: 'Zoë 李雷 🎉 Müller', tags: ['日本語', '🔥'] });
    const found = await page(cookieA, `?q=${encodeURIComponent('李雷 🎉')}`);
    expect(found.items.map((i) => i.id)).toContain(c.id);
  });
});

describe('fix round 3: contact id path guard', () => {
  it.each([
    ['a NUL', '%00'],
    ['path traversal', '..%2Fx'],
    ['a wrong-shape id', 'ct_x'],
    ['an uppercase-hex id', `ct_${'A'.repeat(32)}`],
  ])('404 not_found for %s, for every id route', async (_, id) => {
    const gets = [
      get(`/api/v1/contacts/${id}`, cookieA),
      patch(`/api/v1/contacts/${id}`, cookieA, { company: 'X' }),
      post(`/api/v1/contacts/${id}/archive`, cookieA, {}),
      post(`/api/v1/contacts/${id}/restore`, cookieA, {}),
    ];
    for (const r of await Promise.all(gets)) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({
        data: null,
        error: { code: 'not_found', message: 'Contact not found.' },
      });
    }
  });

  it('audits a malformed id with a null entityId', async () => {
    await get('/api/v1/contacts/%00', cookieA);
    const rows = (await auditsOf(orgA)).filter(
      (e) => e.action === 'contact.read' && e.metadata.reason === 'malformed_id',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ outcome: 'not_found', entityId: null });
  });

  it('404 for a valid-shape unknown id, audited with that id', async () => {
    const id = `ct_${crypto.randomUUID().replaceAll('-', '')}`;
    const r = await patch(`/api/v1/contacts/${id}`, cookieA, { company: 'X' });
    expect(r.status).toBe(404);
    expect(
      (await auditsOf(orgA)).filter((e) => e.entityId === id && e.action === 'contact.update'),
    ).toEqual([expect.objectContaining({ outcome: 'not_found' })]);
  });
});

import { withTenant } from '@knoqra/db';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { get, post, signUp, uniqueEmail, withAppDb } from './helpers';

/**
 * Equivalence oracle for the contact list and search. The expected ids come from the original
 * predicates (three ILIKEs, the phone digits LIKE, ordered by lower(display_name), id), run here
 * as knoqra_app under RLS. The API must return exactly the same ids, however it computes them.
 */

type ContactRow = { id: string; displayName: string };
type Page = { items: ContactRow[]; nextCursor: string | null };
type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

const MIN_PHONE_DIGITS = 3;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

async function createContact(cookie: string, body: Record<string, unknown>): Promise<ContactRow> {
  const r = await post('/api/v1/contacts', cookie, body);
  const json = (await r.json()) as Envelope<ContactRow>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data;
}

async function listPage(cookie: string, params: Record<string, string>): Promise<Page> {
  const r = await get(`/api/v1/contacts?${new URLSearchParams(params)}`, cookie);
  const json = (await r.json()) as Envelope<Page>;
  if (r.status !== 200 || !json.data) throw new Error(`list failed: ${r.status}`);
  return json.data;
}

/** Independent copy of the route's LIKE escaping: backslash before \, % and _. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The pre-M6c search, verbatim in SQL, as the app role inside the tenant's RLS context. */
function oracleSearchIds(orgId: string, q: string): Promise<string[]> {
  const pattern = `%${escapeLike(q)}%`;
  const digits = q.replace(/\D/g, '');
  const phone =
    digits.length >= MIN_PHONE_DIGITS ? sql`or phone_e164 like ${`%${digits}%`}` : sql``;
  return withAppDb((db) =>
    withTenant(db, orgId, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select id from contact
        where archived_at is null and merged_into_id is null
          and (display_name ilike ${pattern} or company ilike ${pattern}
               or email ilike ${pattern} ${phone})
        order by lower(display_name), id`);
      return result.rows.map((row) => row.id);
    }),
  );
}

function oracleOrderIds(orgId: string): Promise<string[]> {
  return withAppDb((db) =>
    withTenant(db, orgId, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        select id from contact
        where archived_at is null and merged_into_id is null
        order by lower(display_name), id`);
      return result.rows.map((row) => row.id);
    }),
  );
}

describe('contact search equivalence', () => {
  let cookie: string;
  let orgId: string;

  beforeAll(async () => {
    cookie = await signUp(uniqueEmail('search-oracle'), 'Search Oracle');
    orgId = await orgOf(cookie);
    await createContact(cookie, { displayName: 'Smith', company: 'Acme', phone: '+12025550140' });
    await createContact(cookie, {
      displayName: 'Élodie Durand',
      company: 'Café Ünïcode',
      phone: '+12025550141',
    });
    await createContact(cookie, {
      displayName: '100% Real',
      company: 'under_score',
      phone: '+12025550143',
    });
    // The email reaches 'durand' through the email field alone.
    await createContact(cookie, {
      displayName: 'Plain Person',
      phone: '+12025550142',
      email: 'durand.desk@example.test',
    });
  });

  const queries = [
    'smith acme',
    'ÉLODIE',
    'café',
    '100%',
    'under_score',
    '_',
    '%',
    '0142',
    'durand',
    'ACME',
  ];

  for (const q of queries) {
    it(`q=${JSON.stringify(q)} returns the same ids as the original predicates`, async () => {
      const expected = await oracleSearchIds(orgId, q);
      const page = await listPage(cookie, { q });
      expect(page.items.map((c) => c.id)).toEqual(expected);
      expect(page.nextCursor).toBeNull();
    });
  }

  it('never matches across two fields', async () => {
    expect((await listPage(cookie, { q: 'smith acme' })).items).toEqual([]);
  });

  it('the oracle itself is not vacuous', async () => {
    expect(await oracleSearchIds(orgId, 'ÉLODIE')).toHaveLength(1);
    expect(await oracleSearchIds(orgId, '_')).toHaveLength(1);
    expect(await oracleSearchIds(orgId, '%')).toHaveLength(1);
    expect(await oracleSearchIds(orgId, '0142')).toHaveLength(1);
    expect(await oracleSearchIds(orgId, 'durand')).toHaveLength(2);
  });
});

describe('contact search keyset paging', () => {
  it('pages a search result 2 at a time, each match once, in lower(name), id order', async () => {
    const cookie = await signUp(uniqueEmail('search-paging'), 'Search Paging');
    const orgId = await orgOf(cookie);
    const names = ['zed Pager', 'Pager b', 'PAGER B', 'pager b', 'Pager A', 'Other', 'pager c'];
    for (const [i, displayName] of names.entries()) {
      await createContact(cookie, { displayName, phone: `+1202555018${i}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: Record<string, string> = { q: 'pager', limit: '2' };
      if (cursor) params.cursor = cursor;
      const page = await listPage(cookie, params);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    const expected = await oracleSearchIds(orgId, 'pager');
    expect(expected).toHaveLength(6);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(expected.length);
    expect(seen).toEqual(expected);
  });
});

describe('contact list keyset paging', () => {
  it('pages 3 at a time over 7 mixed-case contacts, each once, in lower(name), id order', async () => {
    const cookie = await signUp(uniqueEmail('paging-oracle'), 'Paging Oracle');
    const orgId = await orgOf(cookie);
    const names = ['beta', 'Alpha', 'ALPHA', 'alpha', 'Gamma', 'delta', 'Beta'];
    for (const [i, displayName] of names.entries()) {
      await createContact(cookie, { displayName, phone: `+1202555016${i}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: Record<string, string> = { limit: '3' };
      if (cursor) params.cursor = cursor;
      const page = await listPage(cookie, params);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(names.length);
    expect(seen).toEqual(await oracleOrderIds(orgId));
  });
});

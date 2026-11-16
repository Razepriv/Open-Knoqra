import { auditEvent, contact, contactPermissionEvent, timelineEvent, withTenant } from '@knoqra/db';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type RowResult = {
  index: number;
  status: 'created' | 'updated' | 'skipped' | 'rejected';
  contactId: string | null;
  error: { code: string; message: string } | null;
};
type ImportData = { results: RowResult[] };

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

// Every test uses a fresh organization (or distinct numbers), so reuse across tests is safe.
const phone = (n: number) => `+1202555${String(n).padStart(4, '0')}`;

const importRows = (cookie: string, body: unknown) => post('/api/v1/contacts/import', cookie, body);

async function run(cookie: string, body: unknown): Promise<RowResult[]> {
  const r = await importRows(cookie, body);
  expect(r.status).toBe(200);
  const json = (await r.json()) as Envelope<ImportData>;
  if (!json.data) throw new Error('no data');
  return json.data.results;
}

const contactsOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(contact)));
const timelineOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(timelineEvent)));
const auditsOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));

async function seed(cookie: string, body: Record<string, unknown>): Promise<string> {
  const r = await post('/api/v1/contacts', cookie, body);
  const json = (await r.json()) as Envelope<{ id: string }>;
  if (r.status !== 201 || !json.data) throw new Error(`seed failed ${r.status}`);
  return json.data.id;
}

/**
 * Polls until exactly one session is blocked by the holder's transaction (the import's
 * multi-row insert waiting on the holder's uncommitted row). Scoped to the holder's backend, so
 * unrelated lock waits in the database cannot satisfy it.
 */
async function waitForImportBlockedBy(holderPid: number): Promise<void> {
  let waiting = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    waiting = await withAdminDb(async (db) => {
      const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))`);
      return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    });
    if (waiting === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected exactly 1 session blocked by the holder, saw ${waiting}`);
}

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('imp-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('imp-b'), 'Owner B');
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

describe('POST /api/v1/contacts/import', () => {
  it('reports each row of a mixed batch with the right status and message', async () => {
    const cookie = await signUp(uniqueEmail('imp-mixed'), 'Mixed');
    const org = await orgOf(cookie);
    const existingSkip = await seed(cookie, { displayName: 'Old Skip', phone: phone(10) });
    const existingUpdate = await seed(cookie, {
      displayName: 'Old Update',
      phone: phone(11),
      company: 'Old Co',
      tags: ['a'],
    });
    const results = await run(cookie, {
      fileName: 'people.csv',
      onDuplicate: 'update',
      rows: [
        { displayName: 'Valid One', phone: phone(1), email: 'one@example.test', tags: ['x'] },
        { displayName: 'No Phone' },
        { displayName: 'Bad Email', phone: phone(2), email: 'nope' },
        { displayName: 'Dup', phone: '(202) 555-0001' },
        { displayName: 'Updated Name', phone: phone(11), jobTitle: 'CTO', tags: ['b', 'a'] },
        { phone: phone(3) },
        { displayName: 'Bad Phone', phone: '12' },
        { displayName: 'Bad TZ', phone: phone(4), timezone: 'Mars/Base' },
      ],
    });
    expect(results.map((r) => r.status)).toEqual([
      'created',
      'rejected',
      'rejected',
      'skipped',
      'updated',
      'rejected',
      'rejected',
      'rejected',
    ]);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results[1]?.error?.message).toBe('Phone is required');
    expect(results[2]?.error?.message).toBe('Email is not valid');
    expect(results[3]?.error?.message).toBe('Duplicate of row 1');
    expect(results[3]?.contactId).toBe(results[0]?.contactId);
    expect(results[4]?.contactId).toBe(existingUpdate);
    expect(results[5]?.error?.message).toBe('Name is required');
    expect(results[6]?.error?.message).toBe('Enter a full number with country code');
    expect(results[7]?.error?.message).toBe('Time zone is not a valid IANA zone');
    expect(results[0]?.error).toBeNull();

    const rows = await contactsOf(org);
    const updated = rows.find((r) => r.id === existingUpdate);
    expect(updated).toMatchObject({
      displayName: 'Updated Name',
      company: 'Old Co',
      jobTitle: 'CTO',
    });
    expect(updated?.tags).toEqual(['a', 'b']);
    expect(rows.find((r) => r.id === existingSkip)?.displayName).toBe('Old Skip');
    expect(rows).toHaveLength(3);
  });

  it('skips existing contacts when onDuplicate is skip', async () => {
    const cookie = await signUp(uniqueEmail('imp-skip'), 'Skip');
    const org = await orgOf(cookie);
    const id = await seed(cookie, { displayName: 'Keep Me', phone: phone(20) });
    const results = await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'skip',
      rows: [{ displayName: 'Overwrite', phone: phone(20) }],
    });
    expect(results[0]).toMatchObject({
      status: 'skipped',
      contactId: id,
      error: { message: 'Already in your contacts' },
    });
    expect((await contactsOf(org))[0]?.displayName).toBe('Keep Me');
  });

  it('rejects updates to archived contacts and creates over a merged contact number', async () => {
    const cookie = await signUp(uniqueEmail('imp-arch'), 'Arch');
    const archived = await seed(cookie, { displayName: 'Arch', phone: phone(30) });
    const merged = await seed(cookie, { displayName: 'Merged', phone: phone(31) });
    const target = await seed(cookie, { displayName: 'Target', phone: phone(32) });
    expect((await post(`/api/v1/contacts/${archived}/archive`, cookie, {})).status).toBe(200);
    const org = await orgOf(cookie);
    await withAppDb((db) =>
      withTenant(db, org, (tx) =>
        tx.update(contact).set({ mergedIntoId: target }).where(eq(contact.id, merged)),
      ),
    );
    const results = await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'update',
      rows: [
        { displayName: 'X', phone: phone(30) },
        { displayName: 'Y', phone: phone(31) },
      ],
    });
    expect(results.map((r) => [r.status, r.error?.message])).toEqual([
      ['rejected', 'Belongs to an archived contact'],
      ['created', undefined],
    ]);
    // A merged contact gave its number up: the import made a new contact with it.
    const createdId = results[1]?.contactId;
    expect(createdId).not.toBe(merged);
    expect((await contactsOf(org)).find((c) => c.id === createdId)?.phoneE164).toBe(phone(31));
  });

  it('sets source, sourceDetail and timeline events, and one audit row with counts only', async () => {
    const cookie = await signUp(uniqueEmail('imp-src'), 'Src');
    const org = await orgOf(cookie);
    const existing = await seed(cookie, { displayName: 'Ex', phone: phone(41) });
    await run(cookie, {
      fileName: 'leads.csv',
      onDuplicate: 'update',
      rows: [
        { displayName: 'New', phone: phone(40) },
        { displayName: 'Ex 2', phone: phone(41) },
        { displayName: 'Bad' },
      ],
    });
    const created = (await contactsOf(org)).find((c) => c.phoneE164 === phone(40));
    expect(created).toMatchObject({ source: 'import', sourceDetail: 'leads.csv' });
    const events = await timelineOf(org);
    expect(events.filter((e) => e.contactId === created?.id).map((e) => [e.kind, e.title])).toEqual(
      [['system', 'Imported from leads.csv']],
    );
    expect(events.filter((e) => e.contactId === existing).map((e) => [e.kind, e.title])).toEqual([
      ['system', 'Updated from import leads.csv'],
    ]);
    const audits = (await auditsOf(org)).filter((a) => a.action === 'contact.import');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({
      created: 1,
      updated: 1,
      skipped: 0,
      rejected: 1,
      fileName: 'leads.csv',
    });
  });

  it('stores a formula-looking name verbatim', async () => {
    const cookie = await signUp(uniqueEmail('imp-formula'), 'Formula');
    const org = await orgOf(cookie);
    await run(cookie, {
      fileName: 'f.csv',
      onDuplicate: 'skip',
      rows: [{ displayName: '=HYPERLINK("x")', phone: phone(50) }],
    });
    expect((await contactsOf(org))[0]?.displayName).toBe('=HYPERLINK("x")');
  });

  it('answers 413 payload_too_large for 501 rows, before schema validation', async () => {
    const rows = Array.from({ length: 501 }, () => ({ bogus: 1 }));
    const r = await importRows(cookieA, { fileName: 'big.csv', onDuplicate: 'skip', rows });
    expect(r.status).toBe(413);
    expect(((await r.json()) as Envelope<null>).error?.code).toBe('payload_too_large');
  });

  it('answers 413 for a body over 1 MB', async () => {
    const r = await api('/api/v1/contacts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: JSON.stringify({ fileName: 'x'.repeat(1_100_000), onDuplicate: 'skip', rows: [] }),
    });
    expect(r.status).toBe(413);
    expect(((await r.json()) as Envelope<null>).error?.code).toBe('payload_too_large');
  });

  it('validates the envelope: 400 for a malformed request', async () => {
    const bad = [
      { fileName: 'a.csv', onDuplicate: 'skip', rows: [] },
      { fileName: 'a.csv', onDuplicate: 'merge', rows: [{ phone: phone(1) }] },
      { fileName: '', onDuplicate: 'skip', rows: [{ phone: phone(1) }] },
      { onDuplicate: 'skip', rows: [{ phone: phone(1) }] },
      { fileName: 'a.csv', onDuplicate: 'skip', rows: 'nope' },
      { fileName: 'a.csv', rows: [{ phone: phone(1) }] },
    ];
    for (const body of bad) {
      const r = await importRows(cookieA, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as Envelope<null>).error?.code).toBe('validation_error');
    }
  });

  it('answers 400 for malformed JSON', async () => {
    const r = await api('/api/v1/contacts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieA },
      body: '{not json',
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<null>).error?.code).toBe('validation_error');
  });

  describe('one bad row in an otherwise good batch', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['an over-long name', { displayName: 'n'.repeat(121) }, 'Name is too long'],
      ['a control character', { company: 'a\u0000b' }, 'Company contains invalid characters'],
      ['a number cell', { jobTitle: 42 }, 'Job title must be text'],
      ['an object cell', { company: { x: 1 } }, 'Company must be text'],
      [
        '21 tags',
        { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        'Too many tags (max 20)',
      ],
      ['a 41-character tag', { tags: ['t'.repeat(41)] }, 'Tag is too long (max 40)'],
    ];
    it.each(cases)('rejects only the row with %s', async (_label, bad, message) => {
      const cookie = await signUp(uniqueEmail('imp-bad'), 'Bad');
      const org = await orgOf(cookie);
      const results = await run(cookie, {
        fileName: 'a.csv',
        onDuplicate: 'skip',
        rows: [
          { displayName: 'Good 1', phone: phone(1) },
          { displayName: 'Bad', phone: phone(2), ...bad },
          { displayName: 'Good 2', phone: phone(3) },
        ],
      });
      expect(results.map((r) => r.status)).toEqual(['created', 'rejected', 'created']);
      expect(results[1]?.error).toEqual({ code: 'validation_error', message });
      expect(await contactsOf(org)).toHaveLength(2);
    });

    it('treats null and empty cells as absent', async () => {
      const cookie = await signUp(uniqueEmail('imp-null'), 'Null');
      const org = await orgOf(cookie);
      const results = await run(cookie, {
        fileName: 'a.csv',
        onDuplicate: 'skip',
        rows: [
          {
            displayName: 'Nulls',
            phone: phone(1),
            company: null,
            email: '',
            timezone: null,
            tags: null,
          },
        ],
      });
      expect(results[0]?.status).toBe('created');
      expect((await contactsOf(org))[0]).toMatchObject({
        company: null,
        email: null,
        timezone: null,
        tags: [],
      });
    });
  });

  describe('onDuplicate update', () => {
    it('caps merged tags at 20 and never overwrites with blank cells', async () => {
      const cookie = await signUp(uniqueEmail('imp-upd'), 'Upd');
      const org = await orgOf(cookie);
      const id = await seed(cookie, {
        displayName: 'Keep',
        phone: phone(80),
        company: 'Keep Co',
        email: 'keep@example.test',
        tags: Array.from({ length: 19 }, (_, i) => `old${i}`),
      });
      const results = await run(cookie, {
        fileName: 'a.csv',
        onDuplicate: 'update',
        rows: [
          {
            displayName: 'Keep',
            phone: phone(80),
            company: '',
            email: null,
            jobTitle: '  ',
            tags: ['new1', 'new2', 'new3'],
          },
        ],
      });
      expect(results[0]?.status).toBe('updated');
      const row = (await contactsOf(org)).find((c) => c.id === id);
      expect(row).toMatchObject({ company: 'Keep Co', email: 'keep@example.test', jobTitle: null });
      expect(row?.tags).toHaveLength(20);
      expect(row?.tags.at(-1)).toBe('new1');
    });

    it('reports Already up to date for an unchanged contact', async () => {
      const cookie = await signUp(uniqueEmail('imp-same'), 'Same');
      const org = await orgOf(cookie);
      const id = await seed(cookie, { displayName: 'Same', phone: phone(81), tags: ['a'] });
      const results = await run(cookie, {
        fileName: 'a.csv',
        onDuplicate: 'update',
        rows: [{ displayName: 'Same', phone: phone(81), tags: ['a'] }],
      });
      expect(results[0]).toMatchObject({
        status: 'skipped',
        contactId: id,
        error: { message: 'Already up to date' },
      });
      expect((await timelineOf(org)).filter((e) => e.contactId === id)).toHaveLength(0);
    });
  });

  it('never touches consent', async () => {
    const cookie = await signUp(uniqueEmail('imp-consent'), 'Consent');
    const org = await orgOf(cookie);
    await seed(cookie, { displayName: 'Ex', phone: phone(90) });
    await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'update',
      rows: [
        { displayName: 'Ex 2', phone: phone(90) },
        { displayName: 'New', phone: phone(91) },
      ],
    });
    const events = await withAppDb((db) =>
      withTenant(db, org, (tx) => tx.select().from(contactPermissionEvent)),
    );
    expect(events).toHaveLength(0);
  });

  it('skips a row whose phone another transaction inserts concurrently', async () => {
    const cookie = await signUp(uniqueEmail('imp-race'), 'Race');
    const org = await orgOf(cookie);
    let holderInserted!: (pid: number) => void;
    const inserted = new Promise<number>((resolve) => {
      holderInserted = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withAdminDb((db) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '10s'`));
        await tx.insert(contact).values({
          organizationId: org,
          displayName: 'Raced',
          phoneE164: phone(95),
        });
        const pidRow = await tx.execute(sql`select pg_backend_pid()::int as pid`);
        holderInserted(Number((pidRow.rows[0] as { pid: number }).pid));
        await released;
      }),
    );
    const holderPid = await inserted;
    const pending = importRows(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'skip',
      rows: [
        { displayName: 'Mine', phone: phone(95) },
        { displayName: 'Other', phone: phone(96) },
      ],
    });
    try {
      await waitForImportBlockedBy(holderPid);
    } finally {
      release();
      await holder;
    }
    const r = await pending;
    expect(r.status).toBe(200);
    const results = ((await r.json()) as Envelope<ImportData>).data?.results ?? [];
    expect(results.map((x) => x.status)).toEqual(['skipped', 'created']);
    expect(results[0]?.error?.message).toBe('Already in your contacts');
    const rows = await contactsOf(org);
    expect(rows.filter((c) => c.phoneE164 === phone(95))).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('answers per row, in request order, with ids mapped by phone (descending phones)', async () => {
    const cookie = await signUp(uniqueEmail('imp-order'), 'Order');
    const org = await orgOf(cookie);
    const existing = await seed(cookie, { displayName: 'Existing', phone: phone(120) });
    const results = await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'skip',
      rows: [
        { displayName: 'A', phone: phone(150) },
        { displayName: 'B', phone: phone(140) },
        { displayName: 'Existing again', phone: phone(120) },
        { displayName: 'C', phone: phone(130) },
        { displayName: 'B again', phone: phone(140) },
        { displayName: 'D', phone: phone(110) },
      ],
    });
    expect(results.map((r, i) => r.index === i)).toEqual(Array(6).fill(true));
    expect(results.map((r) => r.status)).toEqual([
      'created',
      'created',
      'skipped',
      'created',
      'skipped',
      'created',
    ]);
    const holder = new Map((await contactsOf(org)).map((c) => [c.phoneE164, c.id]));
    expect(results[0]?.contactId).toBe(holder.get(phone(150)));
    expect(results[1]?.contactId).toBe(holder.get(phone(140)));
    expect(results[2]?.contactId).toBe(existing);
    expect(results[2]?.contactId).toBe(holder.get(phone(120)));
    expect(results[3]?.contactId).toBe(holder.get(phone(130)));
    expect(results[4]?.contactId).toBe(holder.get(phone(140)));
    expect(results[4]?.error?.message).toBe('Duplicate of row 2');
    expect(results[5]?.contactId).toBe(holder.get(phone(110)));
    expect(new Set(results.map((r) => r.contactId)).size).toBe(5);
  });

  it('rejects non-object rows individually', async () => {
    const cookie = await signUp(uniqueEmail('imp-nonobj'), 'NonObj');
    const results = await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'skip',
      rows: [null, 'text', [1, 2], { displayName: 'Good', phone: phone(1) }],
    });
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'created']);
    for (const r of results.slice(0, 3)) {
      expect(r.error).toEqual({
        code: 'validation_error',
        message: 'Row must be an object with named columns',
      });
    }
  });

  it('drops null and blank tag items', async () => {
    const cookie = await signUp(uniqueEmail('imp-tags'), 'Tags');
    const org = await orgOf(cookie);
    const results = await run(cookie, {
      fileName: 'a.csv',
      onDuplicate: 'skip',
      rows: [{ displayName: 'T', phone: phone(1), tags: ['a', null, '', '  ', 'b'] }],
    });
    expect(results[0]?.status).toBe('created');
    expect((await contactsOf(org))[0]?.tags).toEqual(['a', 'b']);
  });

  it('requires a session', async () => {
    const r = await api('/api/v1/contacts/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('is isolated per organization', async () => {
    const idA = await seed(cookieA, { displayName: 'Org A Person', phone: phone(60) });
    const results = await run(cookieB, {
      fileName: 'b.csv',
      onDuplicate: 'update',
      rows: [{ displayName: 'Org B Person', phone: phone(60) }],
    });
    expect(results[0]?.status).toBe('created');
    expect(results[0]?.contactId).not.toBe(idA);
    const a = (await contactsOf(orgA)).find((c) => c.id === idA);
    expect(a?.displayName).toBe('Org A Person');
    expect((await contactsOf(orgB)).find((c) => c.phoneE164 === phone(60))?.displayName).toBe(
      'Org B Person',
    );
  });

  it('imports 500 rows in one batch quickly', async () => {
    const cookie = await signUp(uniqueEmail('imp-500'), 'Bulk');
    const org = await orgOf(cookie);
    const rows = Array.from({ length: 500 }, (_, i) => ({
      displayName: `Bulk ${i}`,
      phone: `+1202556${String(i).padStart(4, '0')}`,
      tags: ['bulk'],
    }));
    const started = performance.now();
    const results = await run(cookie, { fileName: 'bulk.csv', onDuplicate: 'update', rows });
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === 'created')).toBe(true);
    expect(await contactsOf(org)).toHaveLength(500);
    expect(elapsed).toBeLessThan(3000);
    // Re-importing the same file changes nothing and is bounded too.
    const again = performance.now();
    const second = await run(cookie, { fileName: 'bulk.csv', onDuplicate: 'update', rows });
    expect(second.every((r) => r.status === 'skipped')).toBe(true);
    expect(performance.now() - again).toBeLessThan(3000);
  });
});

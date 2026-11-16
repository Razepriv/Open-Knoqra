import { newId } from '@knoqra/core';
import { auditEvent, contactPermissionEvent, timelineEvent, withTenant } from '@knoqra/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Contact = { id: string };
type TimelineItem = {
  id: string;
  contactId: string;
  kind: string;
  title: string;
  body: string | null;
  actorUserId: string | null;
  source: string;
  refType: string | null;
  refId: string | null;
  occurredAt: string;
};
type TimelinePage = { items: TimelineItem[]; nextCursor: string | null };
type ChannelRow = {
  channel: string;
  status: string;
  decision: { outcome: string; reason: string };
  source: string | null;
  evidence: string | null;
  updatedAt: string | null;
};
type Permissions = { channels: ChannelRow[] };

let cookieA: string;
let cookieB: string;
let orgA: string;
let orgB: string;
let seq = 0;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

async function newContact(cookie: string): Promise<string> {
  seq += 1;
  const r = await post('/api/v1/contacts', cookie, {
    displayName: `Consent ${seq}`,
    phone: `+1202555${String(1000 + seq).padStart(4, '0')}`,
  });
  const json = (await r.json()) as Envelope<Contact>;
  if (r.status !== 201 || !json.data) throw new Error(`create failed: ${r.status}`);
  return json.data.id;
}

function put(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data: ${JSON.stringify(json.error)}`);
  return json.data;
}

const permissions = async (cookie: string, id: string) =>
  data<Permissions>(await get(`/api/v1/contacts/${id}/permissions`, cookie));
const timeline = async (cookie: string, id: string, query = '') =>
  data<TimelinePage>(await get(`/api/v1/contacts/${id}/timeline${query}`, cookie));
const audits = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(auditEvent)));

const b64url = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('tc-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('tc-b'), 'Owner B');
  orgA = await orgOf(cookieA);
  orgB = await orgOf(cookieB);
});

describe('GET permissions', () => {
  it('reports every channel in order, unknown by default', async () => {
    const id = await newContact(cookieA);
    const { channels } = await permissions(cookieA, id);
    expect(channels.map((c) => c.channel)).toEqual([
      'manual_call',
      'sms',
      'whatsapp',
      'ai_voice',
      'recording',
    ]);
    expect(channels[0]).toMatchObject({
      status: 'unknown',
      decision: { outcome: 'needs_review', reason: 'unknown_manual_call' },
      source: null,
      evidence: null,
      updatedAt: null,
    });
    expect(channels[1]).toMatchObject({
      status: 'unknown',
      decision: { outcome: 'blocked', reason: 'consent_required' },
    });
    expect(channels[3]?.decision.reason).toBe('ai_voice_requires_consent');
  });
});

describe('PUT permissions/{channel}', () => {
  it('grants then revokes, visible immediately, with a timeline event each', async () => {
    const id = await newContact(cookieA);
    const granted = await put(`/api/v1/contacts/${id}/permissions/whatsapp`, cookieA, {
      status: 'granted',
      evidence: 'Verbal OK on call',
    });
    expect(granted.status).toBe(200);
    expect(await data<ChannelRow>(granted)).toMatchObject({
      channel: 'whatsapp',
      status: 'granted',
      decision: { outcome: 'allowed', reason: 'granted' },
      source: 'manual',
      evidence: 'Verbal OK on call',
    });
    expect((await permissions(cookieA, id)).channels[2]?.status).toBe('granted');

    const revoked = await put(`/api/v1/contacts/${id}/permissions/whatsapp`, cookieA, {
      status: 'revoked',
    });
    expect(revoked.status).toBe(200);
    const row = (await permissions(cookieA, id)).channels[2];
    expect(row).toMatchObject({
      status: 'revoked',
      decision: { outcome: 'blocked', reason: 'revoked' },
      evidence: null,
    });
    expect(row?.updatedAt).not.toBeNull();

    const titles = (await timeline(cookieA, id, '?kind=notes_consent')).items.map((i) => i.title);
    expect(titles).toEqual(['WhatsApp consent revoked', 'WhatsApp consent granted']);
  });

  it('uses the exact title copy for every channel and status', async () => {
    const id = await newContact(cookieA);
    const cases: [string, string, string][] = [
      ['manual_call', 'granted', 'Calls consent granted'],
      ['sms', 'opted_out', 'SMS consent set to opted out'],
      ['ai_voice', 'do_not_contact', 'AI voice consent set to do not contact'],
      ['recording', 'revoked', 'Recording consent revoked'],
    ];
    for (const [channel, status] of cases) {
      const r = await put(`/api/v1/contacts/${id}/permissions/${channel}`, cookieA, { status });
      expect(r.status).toBe(200);
    }
    const titles = (await timeline(cookieA, id, '?kind=notes_consent')).items.map((i) => i.title);
    expect(titles.sort()).toEqual(cases.map((c) => c[2]).sort());
  });

  it('resolves a same-timestamp tie by id', async () => {
    const id = await newContact(cookieA);
    const at = new Date('2026-01-01T00:00:00.000Z');
    await withAdminDb((db) =>
      db.insert(contactPermissionEvent).values([
        {
          id: `${newId('cp')}`,
          organizationId: orgA,
          contactId: id,
          channel: 'sms',
          status: 'granted',
          source: 'manual',
          createdAt: at,
        },
        {
          id: `${newId('cp')}`,
          organizationId: orgA,
          contactId: id,
          channel: 'sms',
          status: 'revoked',
          source: 'manual',
          createdAt: at,
        },
      ]),
    );
    const rows = await withAppDb((db) =>
      withTenant(db, orgA, (tx) => tx.select().from(contactPermissionEvent)),
    );
    const mine = rows.filter((r) => r.contactId === id).sort((a, b) => (a.id < b.id ? 1 : -1));
    const winner = mine[0]?.status;
    expect((await permissions(cookieA, id)).channels[1]?.status).toBe(winner);
  });

  it('rejects an unknown channel, an unknown status and control characters with 400', async () => {
    const id = await newContact(cookieA);
    expect(
      (await put(`/api/v1/contacts/${id}/permissions/fax`, cookieA, { status: 'granted' })).status,
    ).toBe(400);
    expect(
      (await put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, { status: 'maybe' })).status,
    ).toBe(400);
    expect(
      (
        await put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, {
          status: 'granted',
          evidence: 'bad\u0000text',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, {
          status: 'granted',
          evidence: 'x'.repeat(501),
        })
      ).status,
    ).toBe(400);
  });

  it('audits the change without evidence text', async () => {
    const id = await newContact(cookieA);
    await put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, {
      status: 'granted',
      evidence: 'secret-evidence-text',
    });
    const rows = (await audits(orgA)).filter(
      (a) => a.action === 'contact.permission.change' && a.entityId === id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'allowed',
      metadata: { channel: 'sms', status: 'granted' },
    });
    expect(JSON.stringify(rows[0])).not.toContain('secret-evidence-text');
  });

  it('refuses archived and merged contacts with 422', async () => {
    const id = await newContact(cookieA);
    await post(`/api/v1/contacts/${id}/archive`, cookieA, {});
    const archived = await put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, {
      status: 'granted',
    });
    expect(archived.status).toBe(422);
    expect(((await archived.json()) as Envelope<never>).error).toEqual({
      code: 'validation_error',
      message: 'Restore this contact first',
    });
    expect((await post(`/api/v1/contacts/${id}/notes`, cookieA, { body: 'x' })).status).toBe(422);
    expect((await post(`/api/v1/contacts/${id}/do-not-contact`, cookieA, {})).status).toBe(422);
    // reads still work
    expect((await get(`/api/v1/contacts/${id}/permissions`, cookieA)).status).toBe(200);
    expect((await get(`/api/v1/contacts/${id}/timeline`, cookieA)).status).toBe(200);

    const merged = await newContact(cookieA);
    const target = await newContact(cookieA);
    await withAdminDb((db) =>
      db.execute(`update contact set merged_into_id = '${target}' where id = '${merged}'` as never),
    );
    const r = await put(`/api/v1/contacts/${merged}/permissions/sms`, cookieA, {
      status: 'granted',
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<never>).error?.message).toBe(
      'Merged contacts cannot be edited',
    );
  });
});

describe('POST do-not-contact', () => {
  it('blocks every channel with one timeline event', async () => {
    const id = await newContact(cookieA);
    const r = await post(`/api/v1/contacts/${id}/do-not-contact`, cookieA, {
      evidence: 'Asked to stop',
    });
    expect(r.status).toBe(200);
    const { channels } = await data<Permissions>(r);
    expect(channels).toHaveLength(5);
    for (const c of channels) {
      expect(c).toMatchObject({
        status: 'do_not_contact',
        decision: { outcome: 'blocked', reason: 'do_not_contact' },
        source: 'manual',
        evidence: 'Asked to stop',
      });
    }
    expect(
      (await permissions(cookieA, id)).channels.every((c) => c.decision.outcome === 'blocked'),
    ).toBe(true);
    const events = (await timeline(cookieA, id, '?kind=notes_consent')).items;
    expect(events.map((e) => e.title)).toEqual(['Marked do not contact on all channels']);
    const audit = (await audits(orgA)).filter(
      (a) => a.action === 'contact.permission.do_not_contact' && a.entityId === id,
    );
    expect(audit[0]?.metadata).toEqual({ channels: 5 });
  });
});

describe('notes and timeline', () => {
  it('creates a note that appears first, and the notes_consent filter excludes system', async () => {
    const id = await newContact(cookieA);
    await post(`/api/v1/contacts/${id}/archive`, cookieA, {});
    await post(`/api/v1/contacts/${id}/restore`, cookieA, {});
    const r = await post(`/api/v1/contacts/${id}/notes`, cookieA, { body: '  Called back  ' });
    expect(r.status).toBe(201);
    const note = await data<TimelineItem>(r);
    expect(note).toMatchObject({
      kind: 'note',
      title: 'Note',
      body: 'Called back',
      contactId: id,
      source: 'app',
    });
    expect(note.actorUserId).not.toBeNull();

    const all = await timeline(cookieA, id);
    expect(all.items[0]?.id).toBe(note.id);
    expect(all.items.some((i) => i.kind === 'system')).toBe(true);
    const filtered = await timeline(cookieA, id, '?kind=notes_consent');
    expect(filtered.items.map((i) => i.kind)).toEqual(['note']);
    expect((await timeline(cookieA, id, '?kind=calls')).items).toEqual([]);

    const audit = (await audits(orgA)).filter(
      (a) => a.action === 'contact.note.create' && a.entityId === id,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain('Called back');
  });

  it('validates note bodies', async () => {
    const id = await newContact(cookieA);
    for (const body of ['', '   ', 'a\u0000b', 'x'.repeat(4001)]) {
      expect((await post(`/api/v1/contacts/${id}/notes`, cookieA, { body })).status).toBe(400);
    }
    expect(
      (await post(`/api/v1/contacts/${id}/notes`, cookieA, { body: 'x'.repeat(4000) })).status,
    ).toBe(201);
  });

  it('pages by keyset with no gaps or duplicates', async () => {
    const id = await newContact(cookieA);
    const rows = Array.from({ length: 7 }, (_, i) => ({
      organizationId: orgA,
      contactId: id,
      kind: 'note' as const,
      title: 'Note',
      body: `n${i}`,
      // Two pairs share a microsecond-precision timestamp, one differs only by microseconds.
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 2))),
    }));
    await withAdminDb((db) => db.insert(timelineEvent).values(rows));
    await withAdminDb((db) =>
      db.execute(
        `update timeline_event set occurred_at = occurred_at + interval '123 microseconds' where contact_id = '${id}' and body = 'n3'` as never,
      ),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q: string = `?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const p: TimelinePage = await timeline(cookieA, id, q);
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('rejects bad kind, limit and cursors with 400', async () => {
    const id = await newContact(cookieA);
    expect((await get(`/api/v1/contacts/${id}/timeline?kind=foo`, cookieA)).status).toBe(400);
    expect((await get(`/api/v1/contacts/${id}/timeline?limit=0`, cookieA)).status).toBe(400);
    expect((await get(`/api/v1/contacts/${id}/timeline?limit=201`, cookieA)).status).toBe(400);
    const bad = [
      'not-base64!!',
      b64url('nope'),
      b64url('{}'),
      b64url(JSON.stringify({ o: 'yesterday', i: 'te_1' })),
      b64url(JSON.stringify({ o: '2026-13-45T00:00:00Z', i: 'te_1' })),
      b64url(JSON.stringify({ o: '0000-01-01T00:00:00Z', i: 'te_1' })),
      b64url(JSON.stringify({ o: '2026-01-01T00:00:00Z', i: 'te_\u0000' })),
      'a'.repeat(1025),
    ];
    for (const cursor of bad) {
      const r = await get(`/api/v1/contacts/${id}/timeline?cursor=${cursor}`, cookieA);
      expect(r.status, cursor.slice(0, 20)).toBe(400);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
    }
  });
});

describe('tenant isolation', () => {
  it('404s with a not_found audit on every route for another tenant contact', async () => {
    const id = await newContact(cookieA);
    const before = (await audits(orgB)).length;
    const calls: Response[] = [
      await get(`/api/v1/contacts/${id}/timeline`, cookieB),
      await post(`/api/v1/contacts/${id}/notes`, cookieB, { body: 'hi' }),
      await get(`/api/v1/contacts/${id}/permissions`, cookieB),
      await put(`/api/v1/contacts/${id}/permissions/sms`, cookieB, { status: 'granted' }),
      await post(`/api/v1/contacts/${id}/do-not-contact`, cookieB, {}),
    ];
    for (const r of calls) {
      expect(r.status).toBe(404);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('not_found');
    }
    const after = (await audits(orgB)).slice(before);
    expect(after).toHaveLength(5);
    expect(after.every((a) => a.outcome === 'not_found' && a.organizationId === orgB)).toBe(true);
    expect(new Set(after.map((a) => a.action)).size).toBe(5);

    // nothing leaked into A
    expect((await permissions(cookieA, id)).channels.every((c) => c.status === 'unknown')).toBe(
      true,
    );
    expect((await timeline(cookieA, id)).items.filter((i) => i.kind !== 'system')).toEqual([]);
  });

  it('404s malformed ids on every route', async () => {
    const bad = 'ct_zzz';
    const r = [
      await get(`/api/v1/contacts/${bad}/timeline`, cookieA),
      await post(`/api/v1/contacts/${bad}/notes`, cookieA, { body: 'x' }),
      await get(`/api/v1/contacts/${bad}/permissions`, cookieA),
      await put(`/api/v1/contacts/${bad}/permissions/sms`, cookieA, { status: 'granted' }),
      await post(`/api/v1/contacts/${bad}/do-not-contact`, cookieA, {}),
    ];
    for (const res of r) expect(res.status).toBe(404);
  });
});

describe('timeline ties, edge cases and refusal audits', () => {
  async function seedTie(id: string): Promise<string[]> {
    const at = new Date('2026-03-01T00:00:00.000Z');
    const ids = ['1', '2', '3'].map((n) => `te_${id.slice(3, 34)}${n}`);
    await withAdminDb((db) =>
      db.insert(timelineEvent).values(
        ids.map((eid, i) => ({
          id: eid,
          organizationId: orgA,
          contactId: id,
          kind: 'note' as const,
          title: 'Note',
          body: `tie${i}`,
          occurredAt: at,
        })),
      ),
    );
    return ids;
  }

  it('orders equal occurred_at by id desc', async () => {
    const id = await newContact(cookieA);
    const ids = await seedTie(id);
    const got = (await timeline(cookieA, id)).items.map((i) => i.id);
    expect(got).toEqual([...ids].sort().reverse());
  });

  it('resumes inside a tie with page size 1, no gaps or duplicates', async () => {
    const id = await newContact(cookieA);
    const ids = await seedTie(id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 6; guard++) {
      const p: TimelinePage = await timeline(
        cookieA,
        id,
        `?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...p.items.map((i) => i.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('rejects an impossible calendar date in a cursor with 400', async () => {
    const id = await newContact(cookieA);
    const cursor = b64url(JSON.stringify({ o: '2026-02-30T00:00:00Z', i: 'te_1' }));
    const r = await get(`/api/v1/contacts/${id}/timeline?cursor=${cursor}`, cookieA);
    expect(r.status).toBe(400);
  });

  it('accepts a bodyless do-not-contact POST', async () => {
    const id = await newContact(cookieA);
    const r = await api(`/api/v1/contacts/${id}/do-not-contact`, {
      method: 'POST',
      headers: { cookie: cookieA },
    });
    expect(r.status).toBe(200);
    const { channels } = await data<Permissions>(r);
    expect(channels.every((c) => c.status === 'do_not_contact' && c.evidence === null)).toBe(true);
  });

  it('audits denied refusals with their reason', async () => {
    const archived = await newContact(cookieA);
    await post(`/api/v1/contacts/${archived}/archive`, cookieA, {});
    const merged = await newContact(cookieA);
    const target = await newContact(cookieA);
    await withAdminDb((db) =>
      db.execute(`update contact set merged_into_id = '${target}' where id = '${merged}'` as never),
    );
    await put(`/api/v1/contacts/${archived}/permissions/sms`, cookieA, { status: 'granted' });
    await post(`/api/v1/contacts/${archived}/notes`, cookieA, { body: 'x' });
    await post(`/api/v1/contacts/${merged}/do-not-contact`, cookieA, {});
    const rows = await audits(orgA);
    const find = (action: string, entity: string) =>
      rows.filter((a) => a.action === action && a.entityId === entity && a.outcome === 'denied');
    expect(find('contact.permission.change', archived)[0]?.metadata).toEqual({
      reason: 'archived',
    });
    expect(find('contact.note.create', archived)[0]?.metadata).toEqual({ reason: 'archived' });
    expect(find('contact.permission.do_not_contact', merged)[0]?.metadata).toEqual({
      reason: 'merged',
    });
  });
});

describe('lifting do not contact needs a reason (owner rule, 2026-11-13)', () => {
  const smsPut = (id: string, body: unknown) =>
    put(`/api/v1/contacts/${id}/permissions/sms`, cookieA, body);
  const smsEvents = async (id: string) =>
    (
      await withAppDb((db) =>
        withTenant(db, orgA, (tx) => tx.select().from(contactPermissionEvent)),
      )
    ).filter((e) => e.contactId === id && e.channel === 'sms');

  async function dncContact(): Promise<string> {
    const id = await newContact(cookieA);
    expect((await post(`/api/v1/contacts/${id}/do-not-contact`, cookieA, {})).status).toBe(200);
    return id;
  }

  it('refuses a grant over do_not_contact without a reason with 422, records nothing, audits it', async () => {
    for (const body of [
      { status: 'granted' },
      { status: 'granted', reason: '' },
      { status: 'granted', reason: '    ' },
      { status: 'granted', evidence: 'Evidence is not a reason' },
    ]) {
      const id = await dncContact();
      const r = await smsPut(id, body);
      expect(r.status).toBe(422);
      const json = (await r.json()) as Envelope<never>;
      expect(json.error?.code).toBe('consent_reason_required');
      expect(json.error?.message).toMatch(/do not contact.*reason/i);
      expect((await permissions(cookieA, id)).channels[1]?.status).toBe('do_not_contact');
      expect(await smsEvents(id)).toHaveLength(1);
      const titles = (await timeline(cookieA, id, '?kind=notes_consent')).items.map((i) => i.title);
      expect(titles).toEqual(['Marked do not contact on all channels']);
      const denied = (await audits(orgA)).filter(
        (a) =>
          a.action === 'contact.permission.change' && a.entityId === id && a.outcome === 'denied',
      );
      expect(denied.map((a) => a.metadata)).toEqual([
        { reason: 'consent_reason_required', channel: 'sms', status: 'granted' },
      ]);
    }
  });

  it('stores the reason on the event, the timeline and the audit', async () => {
    const id = await dncContact();
    const reason = '  Called us on 12 Nov and asked to get texts again.  ';
    const r = await smsPut(id, { status: 'granted', reason });
    expect(r.status).toBe(200);
    expect(await data<ChannelRow>(r)).toMatchObject({
      channel: 'sms',
      status: 'granted',
      decision: { outcome: 'allowed', reason: 'granted' },
      source: 'manual',
      evidence: reason.trim(),
    });
    // Only SMS is lifted; every other channel stays do not contact.
    const { channels } = await permissions(cookieA, id);
    expect(channels.filter((c) => c.status === 'do_not_contact')).toHaveLength(4);

    const events = await smsEvents(id);
    const latest = events.find((e) => e.status === 'granted');
    expect(latest?.evidence).toBe(reason.trim());

    const [entry] = (await timeline(cookieA, id, '?kind=notes_consent')).items;
    expect(entry).toMatchObject({
      kind: 'consent',
      title: 'SMS consent granted (do-not-contact lifted)',
      body: reason.trim(),
      refType: 'contact_permission_event',
      refId: latest?.id,
    });

    const allowed = (await audits(orgA)).filter(
      (a) =>
        a.action === 'contact.permission.change' && a.entityId === id && a.outcome === 'allowed',
    );
    expect(allowed.map((a) => a.metadata)).toEqual([
      {
        channel: 'sms',
        status: 'granted',
        previousStatus: 'do_not_contact',
        doNotContactLifted: true,
        reason: reason.trim(),
      },
    ]);
  });

  it('needs no reason for any other transition', async () => {
    const id = await newContact(cookieA);
    // unknown -> granted, granted -> revoked, revoked -> do_not_contact
    for (const status of ['granted', 'revoked', 'do_not_contact']) {
      expect((await smsPut(id, { status })).status).toBe(200);
    }
    // do_not_contact -> revoked / opted_out / do_not_contact: still not a lift
    for (const status of ['revoked', 'do_not_contact', 'opted_out', 'do_not_contact']) {
      expect((await smsPut(id, { status })).status).toBe(200);
    }
    // opted_out -> granted is a grant, but not over do not contact
    const other = await newContact(cookieA);
    await put(`/api/v1/contacts/${other}/permissions/whatsapp`, cookieA, { status: 'opted_out' });
    expect(
      (await put(`/api/v1/contacts/${other}/permissions/whatsapp`, cookieA, { status: 'granted' }))
        .status,
    ).toBe(200);
    const titles = (await timeline(cookieA, id, '?kind=notes_consent')).items.map((i) => i.title);
    expect(titles.some((t) => t.includes('lifted'))).toBe(false);
  });

  it('keeps an optional reason on other transitions, on the timeline and in the audit', async () => {
    const id = await newContact(cookieA);
    const r = await smsPut(id, { status: 'revoked', reason: 'Asked us to pause texts' });
    expect(r.status).toBe(200);
    expect((await data<ChannelRow>(r)).evidence).toBe('Asked us to pause texts');
    const [entry] = (await timeline(cookieA, id, '?kind=notes_consent')).items;
    expect(entry).toMatchObject({ title: 'SMS consent revoked', body: 'Asked us to pause texts' });
    const audit = (await audits(orgA)).find(
      (a) => a.action === 'contact.permission.change' && a.entityId === id,
    );
    expect(audit?.metadata).toEqual({
      channel: 'sms',
      status: 'revoked',
      reason: 'Asked us to pause texts',
    });
  });

  it('rejects a short, too long or control-character reason, and reason with evidence, with 400', async () => {
    const id = await dncContact();
    const bodies = [
      { status: 'granted', reason: 'ok' },
      { status: 'granted', reason: 'x'.repeat(501) },
      { status: 'granted', reason: 'bad\u0000reason' },
      { status: 'granted', reason: 'bell\u0007here' },
      { status: 'granted', reason: 'Called back today', evidence: 'Also evidence' },
    ];
    for (const body of bodies) {
      const r = await smsPut(id, body);
      expect(r.status).toBe(400);
      expect(((await r.json()) as Envelope<never>).error?.code).toBe('validation_error');
    }
    expect((await permissions(cookieA, id)).channels[1]?.status).toBe('do_not_contact');
    // The boundaries are accepted: 5 and 500 characters.
    expect((await smsPut(id, { status: 'granted', reason: 'x'.repeat(500) })).status).toBe(200);
    const again = await dncContact();
    expect((await smsPut(again, { status: 'granted', reason: 'Yes!!' })).status).toBe(200);
  });

  it('leaves the bulk do-not-contact action unchanged', async () => {
    const id = await newContact(cookieA);
    await smsPut(id, { status: 'granted' });
    const r = await post(`/api/v1/contacts/${id}/do-not-contact`, cookieA, {});
    expect(r.status).toBe(200);
    expect((await data<Permissions>(r)).channels.every((c) => c.status === 'do_not_contact')).toBe(
      true,
    );
  });
});

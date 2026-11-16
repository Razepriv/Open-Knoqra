import { env } from 'cloudflare:workers';
import { newId } from '@knoqra/core';
import {
  auditEvent,
  call,
  callRoute,
  contact,
  ledgerEntry,
  providerBalanceSnapshot,
  timelineEvent,
  wallet,
  withTenant,
} from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type CallJson = {
  id: string;
  userId: string;
  direction: 'outbound' | 'inbound';
  state: string;
  contact: { id: string; displayName: string } | null;
  fromE164: string;
  toE164: string;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  billableSeconds: number | null;
  costMicros: number | null;
  hangupCause: string | null;
  outcome: string | null;
  outcomeNote: string | null;
  reviewConfirmed: boolean;
};
type Dial = { provider: string; to: string; from: string; clientState: string };
type Created = { call: CallJson; dial: Dial; warnings: { outcome: string; reason: string }[] };
type Preflight = {
  to: string | null;
  contact: { id: string; displayName: string } | null;
  decision: { outcome: string; reason: string } | null;
  spend: { outcome: string; reason: string };
  reserveMicros: number;
};
type Page = { items: CallJson[]; nextCursor: string | null };
type User = { cookie: string; orgId: string; userId: string };

const PHONE = '+12025550123';
const OTHER_PHONE = '+12025550124';
let keySeq = 0;
const key = () => {
  keySeq += 1;
  return `idem-key-${Date.now()}-${keySeq}`;
};

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

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data (${r.status}): ${JSON.stringify(json.error)}`);
  return json.data;
}

async function nullable<T>(r: Response): Promise<T | null> {
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<T>).data;
}

async function errorOf(r: Response) {
  return ((await r.json()) as Envelope<unknown>).error;
}

async function newContact(u: User, phone = PHONE, name = 'Ada Caller'): Promise<string> {
  const r = await post('/api/v1/contacts', u.cookie, { displayName: name, phone });
  return (await data<{ id: string }>(r)).id;
}

async function setConsent(u: User, contactId: string, status: string): Promise<void> {
  const r = await api(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: u.cookie },
    body: JSON.stringify({ status }),
  });
  expect(r.status).toBe(200);
}

async function grantedContact(u: User, phone = PHONE): Promise<string> {
  const id = await newContact(u, phone);
  await setConsent(u, id, 'granted');
  return id;
}

const dial = (u: User, body: Record<string, unknown>) =>
  post('/api/v1/calls', u.cookie, { idempotencyKey: key(), ...body });

const cancel = (u: User, id: string) => post(`/api/v1/calls/${id}/cancel`, u.cookie, {});

const lockHolder = (userId: string) =>
  env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)).current();

const ledgerOf = (orgId: string) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(ledgerEntry)));

const reservesOf = async (orgId: string) =>
  (await ledgerOf(orgId)).filter((e) => e.kind === 'reserve');

describe('POST /api/v1/calls', () => {
  it('dials a granted contact: 201 with a dial body, a reserve and the lock', async () => {
    const u = await newUser('calls-granted');
    const contactId = await grantedContact(u);
    const r = await dial(u, { contactId });
    expect(r.status).toBe(201);
    const created = await data<Created>(r);
    expect(created.call).toMatchObject({
      userId: u.userId,
      direction: 'outbound',
      state: 'queued',
      contact: { id: contactId, displayName: 'Ada Caller' },
      fromE164: '+12025550100',
      toE164: PHONE,
      outcome: null,
      reviewConfirmed: false,
    });
    expect(created.call.id).toMatch(/^cl_[0-9a-f]{32}$/);
    expect(created.dial).toEqual({
      provider: 'fake',
      to: PHONE,
      from: '+12025550100',
      clientState: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(created.warnings).toEqual([]);
    const reserves = await reservesOf(u.orgId);
    expect(reserves).toHaveLength(1);
    expect(reserves[0]).toMatchObject({
      // 10 minutes at the core's flat voice rate ($0.01).
      heldDeltaMicros: 100_000,
      refType: 'call',
      refId: created.call.id,
    });
    expect(await lockHolder(u.userId)).toBe(created.call.id);
    const route = await withAdminDb((db) =>
      db.select().from(callRoute).where(eq(callRoute.callId, created.call.id)),
    );
    expect(route[0]).toMatchObject({
      organizationId: u.orgId,
      clientState: created.dial.clientState,
      provider: 'fake',
    });
    const [row] = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.id, created.call.id)),
    );
    expect(row?.reservationId).toBe(reserves[0]?.id);
  });

  it('needs review for unknown consent, and dials once confirmed', async () => {
    const u = await newUser('calls-review');
    const contactId = await newContact(u);
    const refused = await dial(u, { contactId });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused))?.code).toBe('needs_review');
    expect(await reservesOf(u.orgId)).toHaveLength(0);
    const r = await dial(u, { contactId, reviewConfirmed: true });
    expect(r.status).toBe(201);
    const created = await data<Created>(r);
    expect(created.call.reviewConfirmed).toBe(true);
    const audits = await withAppDb((db) =>
      withTenant(db, u.orgId, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(and(eq(auditEvent.action, 'call.create'), eq(auditEvent.outcome, 'allowed'))),
      ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityId).toBe(created.call.id);
    expect(audits[0]?.metadata).toMatchObject({ reviewConfirmed: true });
  });

  it('blocks do not contact with 422, no reserve and no lock; a consented dial then succeeds', async () => {
    const u = await newUser('calls-dnc');
    const dncId = await newContact(u);
    expect((await post(`/api/v1/contacts/${dncId}/do-not-contact`, u.cookie, {})).status).toBe(200);
    for (const body of [{ contactId: dncId }, { to: PHONE }, { to: '(202) 555-0123' }]) {
      const r = await dial(u, { ...body, reviewConfirmed: true });
      expect(r.status).toBe(422);
      expect(await errorOf(r)).toEqual({
        code: 'call_blocked',
        message: 'Do not contact. Policy, not a task.',
      });
    }
    expect(await reservesOf(u.orgId)).toHaveLength(0);
    expect(await lockHolder(u.userId)).toBeNull();
    const okId = await grantedContact(u, OTHER_PHONE);
    expect((await dial(u, { contactId: okId })).status).toBe(201);
  });

  it('dials a bare unknown number only with review, and rejects an invalid one', async () => {
    const u = await newUser('calls-bare');
    const refused = await dial(u, { to: '+12025550155' });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused))?.code).toBe('needs_review');
    const invalid = await dial(u, { to: '12', reviewConfirmed: true });
    expect(invalid.status).toBe(422);
    expect((await errorOf(invalid))?.code).toBe('invalid_phone');
    expect((await dial(u, {})).status).toBe(400);
    const r = await dial(u, { to: '+12025550155', reviewConfirmed: true });
    expect(r.status).toBe(201);
    expect((await data<Created>(r)).call.contact).toBeNull();
  });

  it('refuses emergency numbers before authorizing, with or without review', async () => {
    const u = await newUser('calls-emergency');
    for (const to of ['911', '+1 911', '112', '988']) {
      const refused = await dial(u, { to, reviewConfirmed: true });
      expect(refused.status).toBe(422);
      const error = await errorOf(refused);
      expect(error?.code).toBe('emergency_not_supported');
      expect(error?.message).toContain('112');
    }
    expect(await lockHolder(u.userId)).toBeNull();
    const preflight = await get(
      `/api/v1/calls/preflight?to=${encodeURIComponent('911')}`,
      u.cookie,
    );
    expect(preflight.status).toBe(422);
    expect((await errorOf(preflight))?.code).toBe('emergency_not_supported');
  });

  it('refuses a second dial while the first is active', async () => {
    const u = await newUser('calls-busy');
    const contactId = await grantedContact(u);
    expect((await dial(u, { contactId })).status).toBe(201);
    const second = await dial(u, { contactId });
    expect(second.status).toBe(409);
    expect((await errorOf(second))?.code).toBe('call_in_progress');
    expect(await reservesOf(u.orgId)).toHaveLength(1);
  });

  it('grants exactly one of several concurrent dials', async () => {
    const u = await newUser('calls-race');
    const contactId = await grantedContact(u);
    const results = await Promise.all(Array.from({ length: 4 }, () => dial(u, { contactId })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(await reservesOf(u.orgId)).toHaveLength(1);
  });

  it('replays the same idempotency key with 200 and the same body', async () => {
    const u = await newUser('calls-idem');
    const contactId = await grantedContact(u);
    const body = { contactId, idempotencyKey: 'same-key-0001' };
    const first = await post('/api/v1/calls', u.cookie, body);
    expect(first.status).toBe(201);
    const again = await post('/api/v1/calls', u.cookie, body);
    expect(again.status).toBe(200);
    const a = await data<Created>(first);
    const b = await data<Created>(again);
    expect(b.call.id).toBe(a.call.id);
    expect(b.dial).toEqual(a.dial);
    expect(b.warnings).toEqual(a.warnings);
    expect(await reservesOf(u.orgId)).toHaveLength(1);
  });

  it('self-heals a stale lock held by a terminal call', async () => {
    const u = await newUser('calls-stale');
    const contactId = await grantedContact(u);
    const first = await data<Created>(await dial(u, { contactId }));
    await withAdminDb((db) =>
      db.update(call).set({ state: 'completed' }).where(eq(call.id, first.call.id)),
    );
    expect(await lockHolder(u.userId)).toBe(first.call.id);
    const r = await dial(u, { contactId });
    expect(r.status).toBe(201);
    const second = await data<Created>(r);
    expect(await lockHolder(u.userId)).toBe(second.call.id);
  });

  it('refuses with 402 when the stop cap would be passed, holding nothing', async () => {
    const u = await newUser('calls-cap');
    const contactId = await grantedContact(u);
    expect((await get('/api/v1/wallet', u.cookie)).status).toBe(200);
    await withAdminDb((db) =>
      db.update(wallet).set({ stopCapMicros: 50_000 }).where(eq(wallet.organizationId, u.orgId)),
    );
    const r = await dial(u, { contactId });
    expect(r.status).toBe(402);
    expect((await errorOf(r))?.code).toBe('spend_blocked');
    expect(await lockHolder(u.userId)).toBeNull();
    expect(await reservesOf(u.orgId)).toHaveLength(0);
    const calls = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.organizationId, u.orgId)),
    );
    expect(calls).toHaveLength(0);
  });

  it('warns at the warn cap', async () => {
    const u = await newUser('calls-warn');
    const contactId = await grantedContact(u);
    expect((await get('/api/v1/wallet', u.cookie)).status).toBe(200);
    await withAdminDb((db) =>
      db.update(wallet).set({ warnCapMicros: 100_000 }).where(eq(wallet.organizationId, u.orgId)),
    );
    const created = await data<Created>(await dial(u, { contactId }));
    expect(created.warnings).toEqual([{ outcome: 'warn', reason: 'warn_cap' }]);
  });
});

describe('cancel and outcome', () => {
  it('cancel frees the lock and releases the reserve', async () => {
    const u = await newUser('calls-cancel');
    const contactId = await grantedContact(u);
    const created = await data<Created>(await dial(u, { contactId }));
    const r = await cancel(u, created.call.id);
    expect(r.status).toBe(200);
    const canceled = await data<CallJson>(r);
    expect(canceled).toMatchObject({ state: 'canceled', costMicros: 0 });
    expect(canceled.endedAt).not.toBeNull();
    expect(await lockHolder(u.userId)).toBeNull();
    const entries = await ledgerOf(u.orgId);
    const reserve = entries.find((e) => e.kind === 'reserve');
    const release = entries.find((e) => e.kind === 'release');
    expect(release).toMatchObject({ reservationId: reserve?.id, heldDeltaMicros: -100_000 });
    const summary = await data<{ heldMicros: number; balanceMicros: number }>(
      await get('/api/v1/wallet', u.cookie),
    );
    expect(summary).toMatchObject({ heldMicros: 0, balanceMicros: 5_000_000 });
    const again = await cancel(u, created.call.id);
    expect(again.status).toBe(409);
    expect((await errorOf(again))?.code).toBe('invalid_state');
    expect((await dial(u, { contactId })).status).toBe(201);
  });

  it('outcome: 409 before terminal, 200 after cancel, then 409 outcome_exists', async () => {
    const u = await newUser('calls-outcome');
    const contactId = await grantedContact(u);
    const created = await data<Created>(await dial(u, { contactId }));
    const path = `/api/v1/calls/${created.call.id}/outcome`;
    const early = await post(path, u.cookie, { outcome: 'follow_up' });
    expect(early.status).toBe(409);
    expect((await errorOf(early))?.code).toBe('invalid_state');
    expect((await cancel(u, created.call.id)).status).toBe(200);
    const r = await post(path, u.cookie, { outcome: 'follow_up', note: 'Call back Tuesday' });
    expect(r.status).toBe(200);
    expect(await data<CallJson>(r)).toMatchObject({
      outcome: 'follow_up',
      outcomeNote: 'Call back Tuesday',
    });
    const events = await withAppDb((db) =>
      withTenant(db, u.orgId, (tx) =>
        tx.select().from(timelineEvent).where(eq(timelineEvent.kind, 'call')),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      contactId,
      title: 'Outcome: Follow-up',
      body: 'Call back Tuesday',
      refType: 'call',
      refId: created.call.id,
    });
    const twice = await post(path, u.cookie, { outcome: 'connected' });
    expect(twice.status).toBe(409);
    expect((await errorOf(twice))?.code).toBe('outcome_exists');
    expect((await post(path, u.cookie, { outcome: 'nope' })).status).toBe(400);
  });

  it("a teammate's call is 409 invalid_state for cancel and outcome, audited as denied", async () => {
    const u = await newUser('calls-teammate');
    const teammateCall = async (state: 'ringing' | 'completed') => {
      const id = newId('cl');
      await withAdminDb((db) =>
        db.insert(call).values({
          id,
          organizationId: u.orgId,
          userId: `user_teammate_${crypto.randomUUID().slice(0, 8)}`,
          direction: 'outbound',
          state,
          fromE164: '+12025550100',
          toE164: PHONE,
          provider: 'fake',
          clientState: crypto.randomUUID().replaceAll('-', ''),
        }),
      );
      return id;
    };
    const ringing = await teammateCall('ringing');
    const c = await cancel(u, ringing);
    expect(c.status).toBe(409);
    expect((await errorOf(c))?.code).toBe('invalid_state');
    const ended = await teammateCall('completed');
    const o = await post(`/api/v1/calls/${ended}/outcome`, u.cookie, { outcome: 'connected' });
    expect(o.status).toBe(409);
    expect((await errorOf(o))?.code).toBe('invalid_state');

    const rows = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.organizationId, u.orgId)),
    );
    expect(rows.find((r) => r.id === ringing)?.state).toBe('ringing');
    expect(rows.find((r) => r.id === ended)?.outcome).toBeNull();
    const audits = await withAdminDb((db) =>
      db.select().from(auditEvent).where(eq(auditEvent.organizationId, u.orgId)),
    );
    const of = (action: string) => audits.filter((a) => a.action === action);
    expect(of('call.cancel').map((a) => [a.outcome, a.entityId])).toEqual([['denied', ringing]]);
    expect(of('call.outcome').map((a) => [a.outcome, a.entityId])).toEqual([['denied', ended]]);
  });
});

describe('answer', () => {
  async function inboundRinging(u: User): Promise<string> {
    const id = newId('cl');
    await withAdminDb((db) =>
      db.insert(call).values({
        id,
        organizationId: u.orgId,
        userId: u.userId,
        direction: 'inbound',
        state: 'ringing',
        fromE164: '+12025550177',
        toE164: '+12025550100',
        provider: 'fake',
        clientState: crypto.randomUUID().replaceAll('-', ''),
      }),
    );
    return id;
  }

  it('answers an inbound ringing call with a reserve, the lock and a dial body', async () => {
    const u = await newUser('calls-answer');
    const id = await inboundRinging(u);
    const r = await post(`/api/v1/calls/${id}/answer`, u.cookie, {});
    expect(r.status).toBe(200);
    const body = await data<{ call: CallJson; dial: Dial }>(r);
    expect(body.call).toMatchObject({ id, direction: 'inbound', state: 'ringing' });
    expect(body.dial).toMatchObject({ provider: 'fake', to: '+12025550100', from: '+12025550177' });
    expect(await lockHolder(u.userId)).toBe(id);
    expect(await reservesOf(u.orgId)).toHaveLength(1);
    const again = await post(`/api/v1/calls/${id}/answer`, u.cookie, {});
    expect(again.status).toBe(409);
  });

  it('refuses to answer an outbound call', async () => {
    const u = await newUser('calls-answer-out');
    const contactId = await grantedContact(u);
    const created = await data<Created>(await dial(u, { contactId }));
    const r = await post(`/api/v1/calls/${created.call.id}/answer`, u.cookie, {});
    expect(r.status).toBe(409);
    expect((await errorOf(r))?.code).toBe('invalid_state');
  });

  it('refuses to answer while another call holds the lock', async () => {
    const u = await newUser('calls-answer-busy');
    const contactId = await grantedContact(u);
    expect((await dial(u, { contactId })).status).toBe(201);
    const id = await inboundRinging(u);
    const r = await post(`/api/v1/calls/${id}/answer`, u.cookie, {});
    expect(r.status).toBe(409);
    expect((await errorOf(r))?.code).toBe('call_in_progress');
  });

  it('refuses with 402 spend_blocked when the wallet cannot hold the reserve, holding nothing', async () => {
    const u = await newUser('calls-answer-cap');
    expect((await get('/api/v1/wallet', u.cookie)).status).toBe(200);
    // The reserve is $0.10: a $0.05 stop cap refuses it.
    await withAdminDb((db) =>
      db.update(wallet).set({ stopCapMicros: 50_000 }).where(eq(wallet.organizationId, u.orgId)),
    );
    const id = await inboundRinging(u);
    const r = await post(`/api/v1/calls/${id}/answer`, u.cookie, {});
    expect(r.status).toBe(402);
    expect((await errorOf(r))?.code).toBe('spend_blocked');
    expect(await lockHolder(u.userId)).toBeNull();
    expect(await reservesOf(u.orgId)).toHaveLength(0);
    const [row] = await withAdminDb((db) => db.select().from(call).where(eq(call.id, id)));
    expect(row).toMatchObject({ state: 'ringing', reservationId: null });
  });
});

describe('reads', () => {
  it('lists, finds the active call and gets one', async () => {
    const u = await newUser('calls-reads');
    const contactId = await grantedContact(u);
    expect(await nullable<CallJson>(await get('/api/v1/calls/active', u.cookie))).toBeNull();
    const first = await data<Created>(await dial(u, { contactId }));
    expect((await cancel(u, first.call.id)).status).toBe(200);
    const second = await data<Created>(await dial(u, { contactId }));
    const active = await data<CallJson>(await get('/api/v1/calls/active', u.cookie));
    expect(active.id).toBe(second.call.id);
    const one = await data<CallJson>(await get(`/api/v1/calls/${first.call.id}`, u.cookie));
    expect(one).toMatchObject({ id: first.call.id, state: 'canceled' });

    const page1 = await data<Page>(await get('/api/v1/calls?limit=1', u.cookie));
    expect(page1.items.map((c) => c.id)).toEqual([second.call.id]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await data<Page>(
      await get(
        `/api/v1/calls?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
        u.cookie,
      ),
    );
    expect(page2.items.map((c) => c.id)).toEqual([first.call.id]);
    expect(page2.nextCursor).toBeNull();
    const outbound = await data<Page>(await get('/api/v1/calls?direction=outbound', u.cookie));
    expect(outbound.items).toHaveLength(2);
    const inbound = await data<Page>(await get('/api/v1/calls?direction=inbound', u.cookie));
    expect(inbound.items).toHaveLength(0);
    expect((await get('/api/v1/calls?cursor=bad', u.cookie)).status).toBe(400);
  });

  it('shows a deleted contact as null', async () => {
    const u = await newUser('calls-deleted-contact');
    const contactId = await grantedContact(u);
    const created = await data<Created>(await dial(u, { contactId }));
    await withAdminDb((db) => db.delete(contact).where(eq(contact.id, contactId)));
    const one = await data<CallJson>(await get(`/api/v1/calls/${created.call.id}`, u.cookie));
    expect(one.contact).toBeNull();
  });
});

describe('isolation', () => {
  it('org B gets 404 on every /calls/{id} route, audited', async () => {
    const a = await newUser('calls-iso-a');
    const b = await newUser('calls-iso-b');
    const contactId = await grantedContact(a);
    const created = await data<Created>(await dial(a, { contactId }));
    const id = created.call.id;
    const responses = [
      await get(`/api/v1/calls/${id}`, b.cookie),
      await post(`/api/v1/calls/${id}/cancel`, b.cookie, {}),
      await post(`/api/v1/calls/${id}/answer`, b.cookie, {}),
      await post(`/api/v1/calls/${id}/outcome`, b.cookie, { outcome: 'connected' }),
      await get('/api/v1/calls/cl_bad', b.cookie),
    ];
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect((await errorOf(r))?.code).toBe('not_found');
    }
    const audits = await withAppDb((db) =>
      withTenant(db, b.orgId, (tx) =>
        tx.select().from(auditEvent).where(eq(auditEvent.outcome, 'not_found')),
      ),
    );
    expect(audits.filter((x) => x.entityType === 'call')).toHaveLength(5);
    const list = await data<Page>(await get('/api/v1/calls', b.cookie));
    expect(list.items).toHaveLength(0);
    expect(await nullable<CallJson>(await get('/api/v1/calls/active', b.cookie))).toBeNull();
    // The call is untouched.
    const still = await data<CallJson>(await get(`/api/v1/calls/${id}`, a.cookie));
    expect(still.state).toBe('queued');
  });
});

describe('GET /api/v1/calls/preflight', () => {
  it('shows a DNC contact as blocked, and reports spend and the reserve', async () => {
    const u = await newUser('calls-preflight');
    const dncId = await newContact(u);
    expect((await post(`/api/v1/contacts/${dncId}/do-not-contact`, u.cookie, {})).status).toBe(200);
    const byContact = await data<Preflight>(
      await get(`/api/v1/calls/preflight?contactId=${dncId}`, u.cookie),
    );
    expect(byContact).toEqual({
      to: PHONE,
      contact: { id: dncId, displayName: 'Ada Caller' },
      decision: { outcome: 'blocked', reason: 'do_not_contact' },
      spend: { outcome: 'ok', reason: 'ok' },
      // The core prices calls flat, so the preflight names no destination price.
      reserveMicros: 100_000,
      rate: null,
    });
    const byNumber = await data<Preflight>(
      await get(`/api/v1/calls/preflight?to=${encodeURIComponent(PHONE)}`, u.cookie),
    );
    expect(byNumber.decision).toEqual({ outcome: 'blocked', reason: 'do_not_contact' });
    const unknown = await data<Preflight>(
      await get(`/api/v1/calls/preflight?to=${encodeURIComponent('+12025550150')}`, u.cookie),
    );
    expect(unknown).toMatchObject({
      to: '+12025550150',
      contact: null,
      decision: { outcome: 'needs_review', reason: 'unknown_manual_call' },
    });
    const empty = await data<Preflight>(await get('/api/v1/calls/preflight', u.cookie));
    expect(empty).toMatchObject({ to: null, contact: null, decision: null });
    const invalid = await get('/api/v1/calls/preflight?to=12', u.cookie);
    expect(invalid.status).toBe(422);
    expect((await errorOf(invalid))?.code).toBe('invalid_phone');
    const missing = await get(`/api/v1/calls/preflight?contactId=${newId('ct')}`, u.cookie);
    expect(missing.status).toBe(404);
  });
});

const seedSnapshot = (orgId: string, balanceMicros: number, ageMs = 1000) =>
  withAdminDb((db) =>
    db.insert(providerBalanceSnapshot).values({
      organizationId: orgId,
      provider: 'fake',
      status: 'ok',
      balanceMicros,
      currency: 'USD',
      capturedAt: new Date(Date.now() - ageMs),
    }),
  );

describe('provider balance in spend decisions', () => {
  it('refuses with 402 when the fresh provider balance is exhausted, holding nothing', async () => {
    const u = await newUser('calls-prov-stop');
    const contactId = await grantedContact(u);
    await seedSnapshot(u.orgId, 50_000);
    const r = await dial(u, { contactId });
    expect(r.status).toBe(402);
    const error = await errorOf(r);
    expect(error?.code).toBe('spend_blocked');
    expect(error?.message).toBe('The provider balance is too low to place a call.');
    expect(await reservesOf(u.orgId)).toHaveLength(0);
    expect(await lockHolder(u.userId)).toBeNull();
    const calls = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.organizationId, u.orgId)),
    );
    expect(calls).toHaveLength(0);
  });

  it('warns provider_low on a low balance and still dials', async () => {
    const u = await newUser('calls-prov-warn');
    const contactId = await grantedContact(u);
    await seedSnapshot(u.orgId, 1_000_000);
    const r = await dial(u, { contactId });
    expect(r.status).toBe(201);
    expect((await data<Created>(r)).warnings).toEqual([
      { outcome: 'warn', reason: 'provider_low' },
    ]);
  });

  it('ignores a 3 hour old exhausted snapshot', async () => {
    const u = await newUser('calls-prov-stale');
    const contactId = await grantedContact(u);
    await seedSnapshot(u.orgId, 0, 3 * 3600_000);
    expect((await dial(u, { contactId })).status).toBe(201);
  });

  it('shows the merged decision in preflight', async () => {
    const u = await newUser('calls-prov-pre');
    const contactId = await grantedContact(u);
    await seedSnapshot(u.orgId, 50_000);
    const pre = await data<Preflight>(
      await get(`/api/v1/calls/preflight?contactId=${contactId}`, u.cookie),
    );
    expect(pre.spend).toEqual({ outcome: 'stop', reason: 'provider_exhausted' });
  });
});

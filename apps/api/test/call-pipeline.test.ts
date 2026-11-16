import { env } from 'cloudflare:workers';
import {
  call,
  callEvent,
  ledgerEntry,
  providerEventRaw,
  providerNumberRoute,
  timelineEvent,
  voicemail,
  withTenant,
} from '@knoqra/db';
import { FakeProvider, TelnyxWebhookAdapter } from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { logger } from '../src/lib/logger';
import { handleProviderEvents } from '../src/queue/consumer';
import { handleDeadLetters, isDeadLetterQueue } from '../src/queue/dead-letter';
import { ingestWebhook } from '../src/routes/webhooks';
import { settleReservation } from '../src/services/ledger';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

/*
 * The pipeline end to end, without the Workers queue: `ingestWebhook` runs with a recording queue
 * double (as in webhooks.test.ts), then `handleProviderEvents` gets a hand-built batch of the
 * recorded messages. Calls are created through the real POST /api/v1/calls route.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type User = { cookie: string; orgId: string; userId: string };
type Created = { call: { id: string }; dial: { clientState: string; to: string; from: string } };
type Sent = { rawEventId: string };

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });
const T0 = Date.parse('2026-11-12T09:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}_${crypto.randomUUID().slice(0, 8)}`;
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

async function newContact(u: User, phone: string, consent = true): Promise<string> {
  const r = await post('/api/v1/contacts', u.cookie, { displayName: 'Ada Caller', phone });
  const id = (await data<{ id: string }>(r)).id;
  if (consent) {
    const put = await fetchPut(`/api/v1/contacts/${id}/permissions/manual_call`, u.cookie, {
      status: 'granted',
    });
    expect(put.status).toBe(200);
  }
  return id;
}

function fetchPut(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function dialContact(u: User, phone = '+12025550123'): Promise<Created> {
  const contactId = await newContact(u, phone);
  const r = await post('/api/v1/calls', u.cookie, {
    contactId,
    idempotencyKey: nextId('idem'),
  });
  expect(r.status).toBe(201);
  return data<Created>(r);
}

function newSpy(base: Env = env as unknown as Env) {
  const sent: Sent[] = [];
  const queue = { send: async (m: Sent) => void sent.push(m) };
  return { sent, env: { ...base, PROVIDER_EVENTS: queue } as unknown as Env };
}

type FakeType =
  | 'call.initiated'
  | 'call.ringing'
  | 'call.answered'
  | 'call.completed'
  | 'call.failed'
  | 'call.voicemail';

interface EventSpec {
  type: FakeType;
  providerCallId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

function fakeBody(spec: EventSpec): string {
  return JSON.stringify({
    id: nextId('fake_ev'),
    type: spec.type,
    occurred_at: spec.occurredAt,
    resource_id: spec.providerCallId,
    payload: spec.payload,
  });
}

async function ingest(spyEnv: Env, body: string) {
  return ingestWebhook(
    spyEnv,
    fake,
    new Headers({ 'x-fake-signature': await fake.signWebhook(body) }),
    new TextEncoder().encode(body),
  );
}

function batchOf(ids: string[], queue = 'knoqra-provider-events') {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue,
    messages: ids.map((rawEventId) => ({
      id: rawEventId,
      timestamp: new Date(),
      attempts: 1,
      body: { rawEventId },
      ack: () => acked.push(rawEventId),
      retry: () => retried.push(rawEventId),
    })),
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<{ rawEventId: string }>;
  return { batch, acked, retried };
}

/** Ingests the bodies (in order) and returns their raw event ids. */
async function ingestAll(bodies: string[]): Promise<string[]> {
  const spy = newSpy();
  for (const body of bodies) await ingest(spy.env, body);
  return spy.sent.map((m) => m.rawEventId);
}

async function consume(ids: string[], consumerEnv: Env = env as unknown as Env) {
  const b = batchOf(ids);
  await handleProviderEvents(b.batch, consumerEnv);
  return b;
}

const outboundPayload = (created: Created, extra: Record<string, unknown> = {}) => ({
  client_state: created.dial.clientState,
  direction: 'outbound',
  from: created.dial.from,
  to: created.dial.to,
  ...extra,
});

function answeredScenario(created: Created, providerCallId: string): string[] {
  const p = outboundPayload(created);
  return [
    fakeBody({ type: 'call.initiated', providerCallId, occurredAt: at(0), payload: p }),
    fakeBody({ type: 'call.ringing', providerCallId, occurredAt: at(1), payload: p }),
    fakeBody({ type: 'call.answered', providerCallId, occurredAt: at(2), payload: p }),
    fakeBody({
      type: 'call.completed',
      providerCallId,
      occurredAt: at(63),
      payload: outboundPayload(created, { billable_seconds: 61 }),
    }),
  ];
}

const callRow = async (id: string) =>
  (await withAdminDb((db) => db.select().from(call).where(eq(call.id, id))))[0];

const eventsOf = (id: string) =>
  withAdminDb((db) => db.select().from(callEvent).where(eq(callEvent.callId, id)));

const settlementsOf = (orgId: string, callId: string) =>
  withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntry)
        .where(
          and(eq(ledgerEntry.refId, callId), inArray(ledgerEntry.kind, ['capture', 'release'])),
        ),
    ),
  );

const callTimeline = (callId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(timelineEvent)
      .where(and(eq(timelineEvent.refType, 'call'), eq(timelineEvent.refId, callId))),
  );

const rawRows = (ids: string[]) =>
  withAdminDb((db) => db.select().from(providerEventRaw).where(inArray(providerEventRaw.id, ids)));

const lockHolder = (userId: string) =>
  env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)).current();

describe('outbound call through the pipeline', () => {
  it('initiated, ringing, answered, completed (61 s): completed, 4 events, capture 24,000, lock free, one timeline row', async () => {
    const u = await newUser('pipe-out');
    const created = await dialContact(u);
    expect(await lockHolder(u.userId)).toBe(created.call.id);
    const ids = await ingestAll(answeredScenario(created, nextId('fake_call')));
    expect(ids).toHaveLength(4);

    const run = await consume(ids);
    expect(run.acked).toEqual(ids);
    expect(run.retried).toEqual([]);

    const row = await callRow(created.call.id);
    expect(row).toMatchObject({
      state: 'completed',
      billableSeconds: 61,
      // The core's flat voice rate: $0.01 a started minute.
      costMicros: 20_000,
      hangupCause: 'normal',
    });
    expect(row?.answeredAt?.toISOString()).toBe(at(2));
    expect(row?.endedAt?.toISOString()).toBe(at(63));
    expect(await eventsOf(created.call.id)).toHaveLength(4);
    const settlements = await settlementsOf(u.orgId, created.call.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'capture', balanceDeltaMicros: -20_000 });
    expect(await lockHolder(u.userId)).toBeNull();
    const timeline = await callTimeline(created.call.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      kind: 'call',
      title: 'Outbound call · 1:01',
      source: 'provider',
      refType: 'call',
      refId: created.call.id,
    });
    expect(timeline[0]?.occurredAt.toISOString()).toBe(at(63));
    expect((await rawRows(ids)).map((r) => r.status)).toEqual(ids.map(() => 'processed' as const));
  });

  it('the same webhook twice and the same raw message twice: still 4 events and one settlement', async () => {
    const u = await newUser('pipe-replay');
    const created = await dialContact(u);
    const bodies = answeredScenario(created, nextId('fake_call'));
    const ids = await ingestAll(bodies);
    // Second delivery of every webhook: deduplicated at ingest, nothing queued.
    expect(await ingestAll(bodies)).toEqual([]);

    await consume(ids);
    const again = await consume([...ids, ...ids]);
    expect(again.acked).toHaveLength(8);
    expect(again.retried).toEqual([]);

    expect(await eventsOf(created.call.id)).toHaveLength(4);
    expect(await settlementsOf(u.orgId, created.call.id)).toHaveLength(1);
    expect(await callTimeline(created.call.id)).toHaveLength(1);
    expect((await callRow(created.call.id))?.state).toBe('completed');
    // Replays did not count as attempts: the first run made each row's only attempt.
    expect((await rawRows(ids)).map((r) => r.attempts)).toEqual(ids.map(() => 1));
  });
});

describe('out-of-order delivery', () => {
  it('completed, then a late answered and ringing: stays completed, the late signals change nothing', async () => {
    const u = await newUser('pipe-order');
    const created = await dialContact(u);
    const providerCallId = nextId('fake_call');
    const p = outboundPayload(created);
    const [initiated, , answered] = answeredScenario(created, providerCallId);
    await consume(await ingestAll([initiated as string, answered as string]));

    const late = await ingestAll([
      fakeBody({
        type: 'call.completed',
        providerCallId,
        occurredAt: at(40),
        payload: outboundPayload(created, { billable_seconds: 38 }),
      }),
      fakeBody({ type: 'call.answered', providerCallId, occurredAt: at(2), payload: p }),
      fakeBody({ type: 'call.ringing', providerCallId, occurredAt: at(1), payload: p }),
    ]);
    const run = await consume(late);
    expect(run.acked).toEqual(late);

    const row = await callRow(created.call.id);
    expect(row).toMatchObject({ state: 'completed', billableSeconds: 38, costMicros: 10_000 });
    const events = await eventsOf(created.call.id);
    expect(events).toHaveLength(5);
    const skipped = events.filter((e) => e.stateBefore === 'completed');
    expect(skipped.map((e) => e.stateAfter)).toEqual(['completed', 'completed']);
    expect(await settlementsOf(u.orgId, created.call.id)).toHaveLength(1);
  });

  /** Delivers completed (optionally billed), then answered, then ringing, to a fresh call. */
  async function reverseOrder(created: Created, billableSeconds: number | null) {
    const providerCallId = nextId('fake_call');
    const p = outboundPayload(created);
    const ids = await ingestAll([
      fakeBody({
        type: 'call.completed',
        providerCallId,
        occurredAt: at(30),
        payload:
          billableSeconds === null
            ? p
            : outboundPayload(created, { billable_seconds: billableSeconds }),
      }),
      fakeBody({ type: 'call.answered', providerCallId, occurredAt: at(2), payload: p }),
      fakeBody({ type: 'call.ringing', providerCallId, occurredAt: at(1), payload: p }),
    ]);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const run = await consume(ids);
      expect(run.acked).toEqual(ids);
      return {
        ids,
        lateAnswers: warn.mock.calls.filter(([msg]) => msg === 'call.late_answer'),
      };
    } finally {
      warn.mockRestore();
    }
  }

  it('R17: completed (30 s billed), answered, ringing on a fresh call: the billed hangup infers the answer, completed, capture 12,000', async () => {
    const u = await newUser('pipe-r17');
    const created = await dialContact(u);
    const { ids, lateAnswers } = await reverseOrder(created, 30);

    const row = await callRow(created.call.id);
    expect(row).toMatchObject({
      state: 'completed',
      billableSeconds: 30,
      costMicros: 10_000,
      hangupCause: 'normal',
    });
    // answered_at = ended_at - billable seconds.
    expect(row?.answeredAt?.toISOString()).toBe(at(0));
    expect(row?.endedAt?.toISOString()).toBe(at(30));
    const settlements = await settlementsOf(u.orgId, created.call.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'capture', balanceDeltaMicros: -10_000 });
    expect((await callTimeline(created.call.id)).map((t) => t.title)).toEqual([
      'Outbound call · 0:30',
    ]);
    const events = await eventsOf(created.call.id);
    expect(events).toHaveLength(4);
    expect(events.find((e) => e.signal === 'answered_inferred')).toMatchObject({
      stateBefore: 'queued',
      stateAfter: 'connected',
    });
    expect(events.find((e) => e.signal === 'hangup:normal')).toMatchObject({
      stateBefore: 'connected',
      stateAfter: 'completed',
    });
    expect(lateAnswers).toEqual([
      ['call.late_answer', { callId: created.call.id, rawEventId: ids[1] }],
    ]);
    expect(await lockHolder(u.userId)).toBeNull();
  });

  it('R17: the same order without a billed duration (Telnyx-shaped) is canceled and released, with a late-answer warning', async () => {
    const u = await newUser('pipe-cancel');
    const created = await dialContact(u);
    const { ids, lateAnswers } = await reverseOrder(created, null);

    const row = await callRow(created.call.id);
    expect(row).toMatchObject({ state: 'canceled', billableSeconds: 0, costMicros: 0 });
    expect(row?.answeredAt).toBeNull();
    const settlements = await settlementsOf(u.orgId, created.call.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'release', balanceDeltaMicros: 0 });
    expect(await lockHolder(u.userId)).toBeNull();
    expect((await callTimeline(created.call.id)).map((t) => t.title)).toEqual(['Canceled call']);
    expect(await eventsOf(created.call.id)).toHaveLength(3);
    expect(lateAnswers).toEqual([
      ['call.late_answer', { callId: created.call.id, rawEventId: ids[1] }],
    ]);
  });

  it('a busy hangup before answer is busy with a release and a "Busy" timeline row', async () => {
    const u = await newUser('pipe-busy');
    const created = await dialContact(u, '+12025550190');
    const providerCallId = nextId('fake_call');
    const ids = await ingestAll([
      fakeBody({
        type: 'call.initiated',
        providerCallId,
        occurredAt: at(0),
        payload: outboundPayload(created),
      }),
      fakeBody({
        type: 'call.completed',
        providerCallId,
        occurredAt: at(5),
        payload: outboundPayload(created, { hangup_cause: 'busy' }),
      }),
    ]);
    await consume(ids);
    expect(await callRow(created.call.id)).toMatchObject({ state: 'busy', costMicros: 0 });
    const settlements = await settlementsOf(u.orgId, created.call.id);
    expect(settlements.map((s) => s.kind)).toEqual(['release']);
    expect((await callTimeline(created.call.id)).map((t) => t.title)).toEqual(['Busy']);
  });
});

describe('routing', () => {
  it('parks an unknown client_state: acked, no retry, raw row parked', async () => {
    const ids = await ingestAll([
      fakeBody({
        type: 'call.initiated',
        providerCallId: nextId('fake_call'),
        occurredAt: at(0),
        payload: {
          client_state: 'f'.repeat(32),
          direction: 'outbound',
          from: '+12025550100',
          to: '+12025550123',
        },
      }),
    ]);
    const run = await consume(ids);
    expect(run.acked).toEqual(ids);
    expect(run.retried).toEqual([]);
    const [raw] = await rawRows(ids);
    expect(raw).toMatchObject({ status: 'parked', parkReason: 'unknown_call', attempts: 1 });
    expect(raw?.processedAt).toBeNull();
  });

  it('is route-bound: org A token with org B numbers changes only org A call', async () => {
    const a = await newUser('pipe-route-a');
    const b = await newUser('pipe-route-b');
    const callA = await dialContact(a, '+12025550123');
    const callB = await dialContact(b, '+12025550124');
    const ids = await ingestAll([
      fakeBody({
        type: 'call.initiated',
        providerCallId: nextId('fake_call'),
        occurredAt: at(0),
        payload: {
          client_state: callA.dial.clientState,
          direction: 'outbound',
          from: callB.dial.from,
          to: callB.dial.to,
          org_id: b.orgId,
        },
      }),
    ]);
    await consume(ids);
    expect((await callRow(callA.call.id))?.state).toBe('initiating');
    expect((await callRow(callB.call.id))?.state).toBe('queued');
    expect(await eventsOf(callB.call.id)).toHaveLength(0);
  });

  it('parks call_id_mismatch when a bound call gets a different provider call id', async () => {
    const u = await newUser('pipe-mismatch');
    const created = await dialContact(u);
    const p = outboundPayload(created);
    await consume(
      await ingestAll([
        fakeBody({
          type: 'call.initiated',
          providerCallId: nextId('fake_call'),
          occurredAt: at(0),
          payload: p,
        }),
      ]),
    );
    const ids = await ingestAll([
      fakeBody({
        type: 'call.answered',
        providerCallId: nextId('fake_call'),
        occurredAt: at(2),
        payload: p,
      }),
    ]);
    await consume(ids);
    expect((await rawRows(ids))[0]).toMatchObject({
      status: 'parked',
      parkReason: 'call_id_mismatch',
    });
    expect((await callRow(created.call.id))?.state).toBe('initiating');
  });

  it("parks call_id_mismatch when a token's unbound call is given another call's provider id", async () => {
    const u = await newUser('pipe-foreign-id');
    const other = await newUser('pipe-foreign-id-b');
    const callA = await dialContact(u, '+12025550123');
    const callB = await dialContact(other, '+12025550124');
    const x = nextId('fake_call');
    await consume(
      await ingestAll([
        fakeBody({
          type: 'call.initiated',
          providerCallId: x,
          occurredAt: at(0),
          payload: outboundPayload(callB),
        }),
      ]),
    );
    const beforeB = await callRow(callB.call.id);
    const ids = await ingestAll([
      fakeBody({
        type: 'call.initiated',
        providerCallId: x,
        occurredAt: at(1),
        payload: outboundPayload(callA),
      }),
    ]);
    const run = await consume(ids);
    expect(run.acked).toEqual(ids);
    expect(run.retried).toEqual([]);
    expect((await rawRows(ids))[0]).toMatchObject({
      status: 'parked',
      parkReason: 'call_id_mismatch',
    });
    expect(await callRow(callA.call.id)).toMatchObject({ state: 'queued', providerCallId: null });
    expect(await eventsOf(callA.call.id)).toHaveLength(0);
    const afterB = await callRow(callB.call.id);
    expect(afterB).toMatchObject({ state: beforeB?.state, providerCallId: x });
    expect(await eventsOf(callB.call.id)).toHaveLength(1);
  });

  it('marks an event with nothing to apply as ignored', async () => {
    const ids = await ingestAll([
      fakeBody({
        type: 'call.answered',
        providerCallId: nextId('fake_call'),
        occurredAt: at(0),
        payload: { note: 'no direction' },
      }),
    ]);
    const run = await consume(ids);
    expect(run.acked).toEqual(ids);
    expect((await rawRows(ids))[0]).toMatchObject({ status: 'ignored', attempts: 1 });
  });
});

describe('inbound', () => {
  const FROM = '+12025550142';
  // A number no provider_number_route maps, so the org hint alone decides unless a test adds one.
  const TO = '+12025550199';

  /** Maps `e164` to `orgId` for the duration of `fn`, then removes the route. */
  async function withNumberRoute(e164: string, orgId: string, fn: () => Promise<void>) {
    await withAdminDb((db) =>
      db.insert(providerNumberRoute).values({ provider: 'fake', e164, organizationId: orgId }),
    );
    try {
      await fn();
    } finally {
      await withAdminDb((db) =>
        db
          .delete(providerNumberRoute)
          .where(and(eq(providerNumberRoute.provider, 'fake'), eq(providerNumberRoute.e164, e164))),
      );
    }
  }

  const inboundBody = (
    u: User,
    providerCallId: string,
    type: FakeType,
    seconds: number,
    extra: Record<string, unknown> = {},
  ) =>
    fakeBody({
      type,
      providerCallId,
      occurredAt: at(seconds),
      payload: { direction: 'inbound', from: FROM, to: TO, org_id: u.orgId, ...extra },
    });

  const inboundCall = async (providerCallId: string) =>
    (
      await withAdminDb((db) =>
        db.select().from(call).where(eq(call.providerCallId, providerCallId)),
      )
    )[0];

  it('orgHint creates a ringing call for the owner, matched to the contact; voicemail adds a row and a timeline entry', async () => {
    const u = await newUser('pipe-inbound');
    const contactId = await newContact(u, FROM, false);
    const providerCallId = nextId('fake_in');
    await consume(await ingestAll([inboundBody(u, providerCallId, 'call.initiated', 0)]));

    const created = await inboundCall(providerCallId);
    expect(created).toMatchObject({
      organizationId: u.orgId,
      userId: u.userId,
      contactId,
      direction: 'inbound',
      state: 'ringing',
      fromE164: FROM,
      toE164: TO,
      provider: 'fake',
      reservationId: null,
    });
    if (!created) throw new Error('no inbound call');

    const transcript = "Hi, it's about Thursday's review. Call me back.";
    const ids = await ingestAll([
      inboundBody(u, providerCallId, 'call.voicemail', 25, {
        duration_seconds: 22,
        transcript,
      }),
    ]);
    const run = await consume(ids);
    expect(run.acked).toEqual(ids);

    expect((await callRow(created.id))?.state).toBe('no_answer');
    const vms = await withAdminDb((db) =>
      db.select().from(voicemail).where(eq(voicemail.callId, created.id)),
    );
    expect(vms).toHaveLength(1);
    expect(vms[0]).toMatchObject({
      organizationId: u.orgId,
      contactId,
      fromE164: FROM,
      durationSeconds: 22,
      transcript,
    });
    expect((await callTimeline(created.id)).map((t) => t.title)).toEqual(['Voicemail · 0:22']);
    expect(await settlementsOf(u.orgId, created.id)).toHaveLength(0);
  });

  it('an inbound call that ends unanswered without voicemail is a "Missed call"', async () => {
    const u = await newUser('pipe-missed');
    await newContact(u, FROM, false);
    const providerCallId = nextId('fake_in');
    await consume(
      await ingestAll([
        inboundBody(u, providerCallId, 'call.initiated', 0),
        inboundBody(u, providerCallId, 'call.completed', 20),
      ]),
    );
    const created = await inboundCall(providerCallId);
    expect(created?.state).toBe('canceled');
    expect((await callTimeline(created?.id as string)).map((t) => t.title)).toEqual([
      'Missed call',
    ]);
  });

  it('ignores orgHint in production: the event is parked', async () => {
    const u = await newUser('pipe-inbound-prod');
    const providerCallId = nextId('fake_in');
    const ids = await ingestAll([inboundBody(u, providerCallId, 'call.initiated', 0)]);
    await consume(ids, { ...env, APP_ENV: 'production' } as unknown as Env);
    expect((await rawRows(ids))[0]).toMatchObject({ status: 'parked', parkReason: 'unknown_call' });
    expect(await inboundCall(providerCallId)).toBeUndefined();
  });

  it('the fake org hint wins over a provider_number_route for the dialed number', async () => {
    const u = await newUser('pipe-hint-wins');
    const other = await newUser('pipe-hint-other');
    const number = '+12025550198';
    const providerCallId = nextId('fake_in');
    await withNumberRoute(number, other.orgId, async () => {
      await consume(
        await ingestAll([inboundBody(u, providerCallId, 'call.initiated', 0, { to: number })]),
      );
    });
    expect(await inboundCall(providerCallId)).toMatchObject({
      organizationId: u.orgId,
      userId: u.userId,
      toE164: number,
    });
  });

  it('without an org hint, the dialed number routes the inbound call', async () => {
    const u = await newUser('pipe-number-route');
    const number = '+12025550197';
    const providerCallId = nextId('fake_in');
    await withNumberRoute(number, u.orgId, async () => {
      await consume(
        await ingestAll([
          fakeBody({
            type: 'call.initiated',
            providerCallId,
            occurredAt: at(0),
            payload: { direction: 'inbound', from: FROM, to: number },
          }),
        ]),
      );
    });
    expect(await inboundCall(providerCallId)).toMatchObject({
      organizationId: u.orgId,
      userId: u.userId,
      state: 'ringing',
    });
  });

  it('a voicemail delivered before its ring still makes one call, one voicemail and one timeline entry', async () => {
    const u = await newUser('pipe-vm-first');
    const contactId = await newContact(u, FROM, false);
    const providerCallId = nextId('fake_in');
    const ids = await ingestAll([
      inboundBody(u, providerCallId, 'call.voicemail', 25, {
        duration_seconds: 22,
        transcript: 'Call me back.',
      }),
      inboundBody(u, providerCallId, 'call.initiated', 0),
    ]);
    const run = await consume(ids);
    expect(run.acked).toEqual(ids);
    expect(run.retried).toEqual([]);
    expect((await rawRows(ids)).map((r) => r.status)).toEqual(['processed', 'processed']);

    const calls = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.providerCallId, providerCallId)),
    );
    expect(calls).toHaveLength(1);
    const created = calls[0];
    expect(created).toMatchObject({
      organizationId: u.orgId,
      contactId,
      direction: 'inbound',
      state: 'no_answer',
    });
    const vms = await withAdminDb((db) =>
      db
        .select()
        .from(voicemail)
        .where(eq(voicemail.callId, created?.id as string)),
    );
    expect(vms).toHaveLength(1);
    expect((await callTimeline(created?.id as string)).map((t) => t.title)).toEqual([
      'Voicemail · 0:22',
    ]);
    // The late ring is logged and changes nothing.
    const events = await eventsOf(created?.id as string);
    expect(events).toHaveLength(2);
    const late = events.find((e) => e.signal === 'ringing');
    expect(late).toMatchObject({ stateBefore: 'no_answer', stateAfter: 'no_answer' });
  });
});

describe('inbound concurrency', () => {
  it('two first events for one new inbound call, consumed concurrently, create one call', async () => {
    const u = await newUser('pipe-inbound-race');
    const providerCallId = nextId('fake_in');
    const payload = {
      direction: 'inbound',
      from: '+12025550142',
      to: '+12025550199',
      org_id: u.orgId,
    };
    const [ring, ringing] = await ingestAll([
      fakeBody({ type: 'call.initiated', providerCallId, occurredAt: at(0), payload }),
      fakeBody({ type: 'call.ringing', providerCallId, occurredAt: at(1), payload }),
    ]);
    const runs = await Promise.all([consume([ring as string]), consume([ringing as string])]);
    expect(runs.flatMap((r) => r.acked).sort()).toEqual([ring, ringing].sort());
    expect(runs.flatMap((r) => r.retried)).toEqual([]);
    const calls = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.providerCallId, providerCallId)),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe('ringing');
    expect(await eventsOf(calls[0]?.id as string)).toHaveLength(2);
  });
});

describe('consumer outcomes', () => {
  it('logs skipped_missing and skipped_final at debug', async () => {
    const ids = await ingestAll([
      fakeBody({
        type: 'call.answered',
        providerCallId: nextId('fake_call'),
        occurredAt: at(0),
        payload: { note: 'nothing to apply' },
      }),
    ]);
    await consume(ids);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const run = await consume(['pe_missing', ...ids]);
      expect(run.acked).toEqual(['pe_missing', ...ids]);
      const skips = debug.mock.calls.filter(([msg]) => String(msg).startsWith('queue.skipped'));
      expect(skips).toEqual([
        ['queue.skipped_missing', { rawEventId: 'pe_missing' }],
        ['queue.skipped_final', { rawEventId: ids[0], status: 'ignored' }],
      ]);
    } finally {
      debug.mockRestore();
    }
  });
});

describe('side effects', () => {
  it('a publish failure does not fail the message', async () => {
    const u = await newUser('pipe-publish');
    const created = await dialContact(u);
    const ids = await ingestAll(answeredScenario(created, nextId('fake_call')));
    const broken = {
      ...env,
      ORG_REALTIME: {
        idFromName: () => {
          throw new Error('realtime down');
        },
        get: () => {
          throw new Error('realtime down');
        },
      },
    } as unknown as Env;
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const run = await consume(ids, broken);
      expect(run.acked).toEqual(ids);
      expect(run.retried).toEqual([]);
    } finally {
      error.mockRestore();
    }
    expect((await callRow(created.call.id))?.state).toBe('completed');
    expect(await lockHolder(u.userId)).toBeNull();
  });

  it('logs ledger.settle_mismatch when the reservation was already closed differently', async () => {
    const u = await newUser('pipe-settle-mismatch');
    const created = await dialContact(u);
    const row = await callRow(created.call.id);
    // Close the hold out of band (as an app-side release would), before the provider's hangup.
    await withAppDb((db) =>
      withTenant(db, u.orgId, (tx) =>
        settleReservation(tx, {
          orgId: u.orgId,
          reservationId: row?.reservationId as string,
          costMicros: 0,
          idempotencyKey: `test:${created.call.id}:release`,
          refType: 'call',
          refId: created.call.id,
        }),
      ),
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const ids = await ingestAll(answeredScenario(created, nextId('fake_call')));
      const run = await consume(ids);
      expect(run.acked).toEqual(ids);
      const calls = warn.mock.calls.filter(([msg]) => msg === 'ledger.settle_mismatch');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toEqual({
        callId: created.call.id,
        reservationId: row?.reservationId,
        entryId: expect.any(String),
        expectedKind: 'capture',
        actualKind: 'release',
      });
    } finally {
      warn.mockRestore();
    }
    expect((await callRow(created.call.id))?.state).toBe('completed');
    expect(await settlementsOf(u.orgId, created.call.id)).toHaveLength(1);
  });
});

describe('dead-letter queue', () => {
  it('recognizes dead-letter queue names', () => {
    expect(isDeadLetterQueue('knoqra-provider-events-dlq')).toBe(true);
    expect(isDeadLetterQueue('knoqra-provider-events-dlq-staging')).toBe(true);
    expect(isDeadLetterQueue('knoqra-provider-events-dlq-production')).toBe(true);
    expect(isDeadLetterQueue('knoqra-provider-events')).toBe(false);
    expect(isDeadLetterQueue('knoqra-provider-events-staging')).toBe(false);
  });

  it('marks each raw row dead_lettered and acks', async () => {
    const ids = await ingestAll([
      fakeBody({
        type: 'call.initiated',
        providerCallId: nextId('fake_call'),
        occurredAt: at(0),
        payload: { direction: 'outbound', from: '+12025550100', to: '+12025550123' },
      }),
    ]);
    const b = batchOf([...ids, 'pe_missing'], 'knoqra-provider-events-dlq');
    await handleDeadLetters(b.batch, env as unknown as Env);
    expect(b.acked).toEqual([...ids, 'pe_missing']);
    expect((await rawRows(ids))[0]?.status).toBe('dead_lettered');
  });
});

describe('Ed25519 in workerd', () => {
  it('verifies a Telnyx-style signed body with a generated key', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
    );
    const publicKeyBase64 = btoa(String.fromCharCode(...raw));
    const now = Date.parse('2026-11-12T09:00:00Z');
    const adapter = new TelnyxWebhookAdapter({ publicKeyBase64, now: () => now });
    const body = new TextEncoder().encode('{"data":{"id":"ev_1"}}');
    const timestamp = String(Math.floor(now / 1000));
    const message = new TextEncoder().encode(`${timestamp}|{"data":{"id":"ev_1"}}`);
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message),
    );
    const headers = new Headers({
      'telnyx-signature-ed25519': btoa(String.fromCharCode(...signature)),
      'telnyx-timestamp': timestamp,
    });
    expect(await adapter.verify(headers, body)).toBe(true);
    const tampered = new TextEncoder().encode('{"data":{"id":"ev_2"}}');
    expect(await adapter.verify(headers, tampered)).toBe(false);
  });
});

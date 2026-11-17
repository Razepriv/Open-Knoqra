import { env } from 'cloudflare:workers';
import { assertLedgerInvariants, CALL_CUTOFF_MARGIN_SECONDS, type LedgerLine } from '@knoqra/core';
import {
  auditEvent,
  call,
  callEvent,
  ledgerEntry,
  notification,
  wallet,
  withTenant,
} from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { applyToCall } from '../src/events/call-apply';
import {
  CUT_OFF_SIGNAL,
  cutoffNotice,
  meterLiveCalls,
  runCallMeter,
} from '../src/events/call-meter';
import { startCallMeter } from '../src/events/call-meter-schedule';
import { sweepStaleCalls } from '../src/events/stale-calls';
import type { CallJson } from '../src/lib/call-json';
import { callBillingOf } from '../src/lib/pricing';
import { handleProviderEvents } from '../src/queue/consumer';
import { handleDeadLetters } from '../src/queue/dead-letter';
import type { CallMeterMessage } from '../src/queue/messages';
import { adjust } from '../src/services/ledger';
import {
  api,
  get,
  post,
  saveTelnyxCredential,
  signUp,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

/*
 * Mid-call metering (events/call-meter.ts), driven directly: a call is dialed through the API on
 * the fake provider ($5 starter credit, $0.01 a minute, 10 minutes held), backdated to "answered" with
 * the admin role, then meter steps run with a fixed clock and a recording queue double. Telnyx's
 * hang-up endpoint is a fetch stand-in (no network in tests).
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type User = { cookie: string; orgId: string; userId: string };
type Sent = { body: unknown; delaySeconds: number | undefined };

const workerEnv = env as unknown as Env;
const MINUTE = 60_000;
/** The fake provider's flat price: $0.01 a billed minute, no platform fee in the core. */
const RATE = 10_000;

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

async function dial(u: User): Promise<string> {
  const contactId = (
    await data<{ id: string }>(
      await post('/api/v1/contacts', u.cookie, { displayName: 'Mo Meter', phone: '+12025550177' }),
    )
  ).id;
  const consent = await api(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: u.cookie },
    body: JSON.stringify({ status: 'granted' }),
  });
  expect(consent.status).toBe(200);
  const r = await post('/api/v1/calls', u.cookie, {
    contactId,
    idempotencyKey: `meter-${crypto.randomUUID()}`,
  });
  expect(r.status).toBe(201);
  return (await data<{ call: { id: string } }>(r)).call.id;
}

/** The call as answered `minutesAgo` minutes before `now`, bound to a provider call id. */
async function answered(callId: string, now: Date, minutesAgo: number, providerCallId?: string) {
  await withAdminDb((db) =>
    db
      .update(call)
      .set({
        state: 'connected',
        answeredAt: new Date(now.getTime() - minutesAgo * MINUTE),
        providerCallId: providerCallId ?? `fake-${crypto.randomUUID()}`,
      })
      .where(eq(call.id, callId)),
  );
}

function spyEnv(over: Partial<Env> = {}) {
  const sent: Sent[] = [];
  const queue = {
    send: async (body: unknown, options?: { delaySeconds?: number }) =>
      void sent.push({ body, delaySeconds: options?.delaySeconds }),
  };
  return { sent, env: { ...workerEnv, PROVIDER_EVENTS: queue, ...over } as unknown as Env };
}

const meter = (
  u: User,
  callId: string,
  step: CallMeterMessage['step'],
  paidMinutes: number,
): CallMeterMessage => ({ kind: 'call.meter', step, orgId: u.orgId, callId, paidMinutes });

const callRow = async (id: string) =>
  (await withAdminDb((db) => db.select().from(call).where(eq(call.id, id))))[0];

const holdsOf = (orgId: string, callId: string) =>
  withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.refId, callId))
        .orderBy(ledgerEntry.createdAt),
    ),
  );

const orgLedger = (orgId: string) =>
  withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      tx.select().from(ledgerEntry).orderBy(ledgerEntry.createdAt, ledgerEntry.id),
    ),
  );

/** Sum of the org's held and balance deltas. */
async function totalsOf(orgId: string) {
  const lines = await orgLedger(orgId);
  return {
    balance: lines.reduce((sum, l) => sum + l.balanceDeltaMicros, 0),
    held: lines.reduce((sum, l) => sum + l.heldDeltaMicros, 0),
    lines: lines as unknown as LedgerLine[],
  };
}

/** Leaves `micros` available beyond the call's first hold. */
async function leaveAvailable(orgId: string, micros: number) {
  const { balance, held } = await totalsOf(orgId);
  await withAppDb((db) =>
    withTenant(db, orgId, (tx) =>
      adjust(tx, {
        orgId,
        balanceDeltaMicros: micros - (balance - held),
        note: 'test: drain the wallet',
        idempotencyKey: `test-drain-${crypto.randomUUID()}`,
        refType: 'test',
        refId: 'drain',
        actorUserId: null,
      }),
    ),
  );
}

const setStopCap = (orgId: string, stopCapMicros: number | null) =>
  withAdminDb((db) =>
    db
      .update(wallet)
      .set({ stopCapMicros, warnCapMicros: null })
      .where(eq(wallet.organizationId, orgId)),
  );

const cutoffAudits = (orgId: string, callId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.action, 'call.cut_off'),
          eq(auditEvent.entityId, callId),
        ),
      ),
  );

const cutoffNotices = (callId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(notification)
      .where(eq(notification.dedupeKey, `call_cut_off:${callId}`)),
  );

const lockHolder = (userId: string) =>
  env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)).current();

/** A Telnyx hang-up stand-in: answers every hang-up with `status` (and an error code). */
function telnyxHangups(status = 200, code = '10001') {
  const hungUp: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = /^\/v2\/calls\/([^/]+)\/actions\/hangup$/.exec(url.pathname);
    if (!match || init?.method !== 'POST') return new Response('{}', { status: 500 });
    hungUp.push(decodeURIComponent(match[1] as string));
    if (status === 200) return Response.json({ data: { result: 'ok' } });
    return Response.json({ errors: [{ code }] }, { status });
  }) as typeof fetch;
  return { impl, hungUp };
}

describe('starting the meter', () => {
  it('queues the first extension a minute before the first 10 minutes run out', async () => {
    const u = await newUser('meter-start');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 0);
    const json = await data<CallJson>(await get(`/api/v1/calls/${callId}`, u.cookie));
    expect(Date.parse(json.paidUntil ?? '') - Date.parse(json.answeredAt ?? '')).toBe(10 * MINUTE);
    expect(json.cutOff).toBeNull();

    const spy = spyEnv();
    await startCallMeter(spy.env, u.orgId, { ...json, state: 'connected' }, now);
    expect(spy.sent).toEqual([{ body: meter(u, callId, 'extend', 10), delaySeconds: 9 * 60 }]);
  });

  it('does not meter a call that holds nothing', async () => {
    const spy = spyEnv();
    await startCallMeter(spy.env, 'org_x', {
      id: 'cl_x',
      state: 'connected',
      answeredAt: new Date().toISOString(),
      paidUntil: null,
    } as never);
    expect(spy.sent).toEqual([]);
  });

  it('queues it from the provider pipeline when a call is answered', async () => {
    const u = await newUser('meter-pipeline');
    const callId = await dial(u);
    const spy = spyEnv();
    const row = await callRow(callId);
    if (!row) throw new Error('no call');
    const providerCallId = `fake-${crypto.randomUUID()}`;
    const occurredAt = new Date();
    const applied = await withAppDb((db) =>
      withTenant(db, u.orgId, (tx) =>
        applyToCall(
          tx,
          `test-answer-${callId}`,
          {
            kind: 'call',
            provider: 'fake',
            providerCallId,
            clientState: row.clientState,
            signal: { type: 'answered' },
            direction: 'outbound',
            from: row.fromE164,
            to: row.toE164,
            occurredAt: occurredAt.toISOString(),
            billableSeconds: null,
            voicemail: null,
            orgHint: null,
          },
          callId,
          callBillingOf(workerEnv),
        ),
      ),
    );
    expect(applied.kind).toBe('applied');
    if (applied.kind !== 'applied') return;
    const { fanOutApplied } = await import('../src/events/call-handler');
    await fanOutApplied(spy.env, u.orgId, applied);
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0]?.body).toEqual(meter(u, callId, 'extend', 10));
    expect(spy.sent[0]?.delaySeconds).toBeGreaterThan(9 * 60 - 5);
    expect(spy.sent[0]?.delaySeconds).toBeLessThanOrEqual(9 * 60);
  });
});

describe('mid-call extension', () => {
  it('holds another 10 minutes and queues the next check', async () => {
    const u = await newUser('meter-extend');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();

    const outcome = await withAppDb((db) =>
      runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }),
    );
    expect(outcome).toBe('extended');
    expect((await callRow(callId))?.paidMinutes).toBe(20);
    const holds = await holdsOf(u.orgId, callId);
    expect(holds.map((h) => [h.kind, h.heldDeltaMicros, h.idempotencyKey])).toEqual([
      ['reserve', 10 * RATE, `call:${callId}:reserve`],
      ['reserve', 10 * RATE, `call:${callId}:extend:10`],
    ]);
    // Next check: 19 minutes after the answer, which was 9 minutes ago.
    expect(spy.sent).toEqual([{ body: meter(u, callId, 'extend', 20), delaySeconds: 10 * 60 }]);

    // A repeat of the same step is stale: nothing more is held.
    expect(
      await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now })),
    ).toBe('noop');
    expect(await holdsOf(u.orgId, callId)).toHaveLength(2);
  });

  it('holds only the whole minutes the wallet still covers', async () => {
    const u = await newUser('meter-partial');
    const callId = await dial(u);
    await leaveAvailable(u.orgId, 35_000);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    expect(
      await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now })),
    ).toBe('extended');
    expect((await callRow(callId))?.paidMinutes).toBe(13);
    expect((await holdsOf(u.orgId, callId))[1]?.heldDeltaMicros).toBe(3 * RATE);
    // The wallet is never asked for more than it has.
    const { balance, held } = await totalsOf(u.orgId);
    expect(balance - held).toBe(5_000);
  });

  it('warns and plans the cut-off when the monthly stop cap is reached', async () => {
    const u = await newUser('meter-cap');
    const callId = await dial(u);
    await setStopCap(u.orgId, 10 * RATE);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    expect(
      await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now })),
    ).toBe('warned');

    const row = await callRow(callId);
    const paidUntil = (row?.answeredAt?.getTime() ?? 0) + 10 * MINUTE;
    expect(row).toMatchObject({ state: 'connected', paidMinutes: 10, cutoffReason: 'stop_cap' });
    expect(row?.cutoffAt?.getTime()).toBe(paidUntil - CALL_CUTOFF_MARGIN_SECONDS * 1000);
    expect(await holdsOf(u.orgId, callId)).toHaveLength(1);
    expect(spy.sent).toEqual([{ body: meter(u, callId, 'cutoff', 10), delaySeconds: 50 }]);

    // The Desk and the mobile app read the warning from the call.
    const json = await data<{ cutOff: { reason: string; at: string } | null }>(
      await get(`/api/v1/calls/${callId}`, u.cookie),
    );
    expect(json.cutOff).toEqual({ reason: 'stop_cap', at: row?.cutoffAt?.toISOString() });

    // A second extend step while the cut-off is pending changes nothing.
    expect(
      await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now })),
    ).toBe('noop');
  });

  it('keeps the call going when credit arrives during the warning', async () => {
    const u = await newUser('meter-topup');
    const callId = await dial(u);
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    expect((await callRow(callId))?.cutoffReason).toBe('insufficient_funds');

    await leaveAvailable(u.orgId, 1_000_000);
    const later = new Date(now.getTime() + 50_000);
    expect(
      await withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now: later }),
      ),
    ).toBe('extended');
    expect(await callRow(callId)).toMatchObject({
      state: 'connected',
      paidMinutes: 20,
      cutoffReason: null,
      cutoffAt: null,
    });
    expect(await cutoffAudits(u.orgId, callId)).toHaveLength(0);
  });
});

describe('cut-off', () => {
  it('ends the call, bills it within its paid minutes, and records it once', async () => {
    const u = await newUser('meter-cut');
    const callId = await dial(u);
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    const cutAt = (await callRow(callId))?.cutoffAt;
    if (!cutAt) throw new Error('no cut-off planned');
    const { balance: balanceBefore } = await totalsOf(u.orgId);

    expect(
      await withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now: cutAt }),
      ),
    ).toBe('cut_off');

    const row = await callRow(callId);
    expect(row).toMatchObject({
      state: 'completed',
      hangupCause: 'cut_off',
      cutoffReason: 'insufficient_funds',
      billableSeconds: 590,
      costMicros: 10 * RATE,
    });
    expect(row?.endedAt?.getTime()).toBe(cutAt.getTime());
    const settles = (await holdsOf(u.orgId, callId)).filter((h) => h.kind !== 'reserve');
    expect(settles.map((h) => [h.kind, h.balanceDeltaMicros])).toEqual([['capture', -10 * RATE]]);
    const { balance, held, lines } = await totalsOf(u.orgId);
    expect(balance).toBe(balanceBefore - 10 * RATE);
    expect(held).toBe(0);
    // The wallet never goes below zero.
    expect(balance).toBeGreaterThanOrEqual(0);
    assertLedgerInvariants(lines);

    const events = await withAdminDb((db) =>
      db.select().from(callEvent).where(eq(callEvent.callId, callId)),
    );
    expect(events.find((e) => e.signal === CUT_OFF_SIGNAL)).toMatchObject({
      rawEventId: `cut_off:${callId}`,
      stateBefore: 'connected',
      stateAfter: 'completed',
    });
    const audits = await cutoffAudits(u.orgId, callId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      outcome: 'denied',
      metadata: { reason: 'insufficient_funds', paidMinutes: 10, hangup: 'skipped', via: 'timer' },
    });
    const notices = await cutoffNotices(callId);
    expect(notices.map((n) => [n.userId, n.kind, n.title])).toEqual([
      [u.userId, 'system', cutoffNotice('insufficient_funds').title],
    ]);
    expect(await lockHolder(u.userId)).toBeNull();

    // Replays change nothing: no second charge, audit or notification.
    expect(
      await withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now: cutAt }),
      ),
    ).toBe('noop');
    expect((await holdsOf(u.orgId, callId)).filter((h) => h.kind !== 'reserve')).toHaveLength(1);
    expect(await cutoffAudits(u.orgId, callId)).toHaveLength(1);
    expect(await cutoffNotices(callId)).toHaveLength(1);

    const json = await data<{ hangupCause: string; cutOff: { reason: string } | null }>(
      await get(`/api/v1/calls/${callId}`, u.cookie),
    );
    expect(json).toMatchObject({
      hangupCause: 'cut_off',
      cutOff: { reason: 'insufficient_funds' },
    });
  });

  it('hangs a Telnyx call up with the workspace key before ending it', async () => {
    const u = await newUser('meter-telnyx');
    const callId = await dial(u);
    await saveTelnyxCredential(u.orgId, '+12025550188');
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    const ccid = `v3:${crypto.randomUUID()}`;
    await answered(callId, now, 9, ccid);
    await withAdminDb((db) =>
      db.update(call).set({ provider: 'telnyx' }).where(eq(call.id, callId)),
    );
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));

    // A server error is retried: nothing is recorded yet.
    const failing = telnyxHangups(503);
    await expect(
      withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now, fetch: failing.impl }),
      ),
    ).rejects.toThrow();
    expect(failing.hungUp).toEqual([ccid]);
    expect((await callRow(callId))?.state).toBe('connected');
    expect(await cutoffAudits(u.orgId, callId)).toHaveLength(0);

    const ok = telnyxHangups(200);
    expect(
      await withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now, fetch: ok.impl }),
      ),
    ).toBe('cut_off');
    expect(ok.hungUp).toEqual([ccid]);
    expect((await callRow(callId))?.hangupCause).toBe('cut_off');
    expect((await cutoffAudits(u.orgId, callId))[0]?.metadata).toMatchObject({
      hangup: 'hung_up',
      provider: 'telnyx',
      providerCallId: ccid,
    });
  });

  it('counts a call Telnyx already ended as hung up', async () => {
    const u = await newUser('meter-telnyx-ended');
    const callId = await dial(u);
    await saveTelnyxCredential(u.orgId, '+12025550189');
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    await answered(callId, now, 9, `v3:${crypto.randomUUID()}`);
    await withAdminDb((db) =>
      db.update(call).set({ provider: 'telnyx' }).where(eq(call.id, callId)),
    );
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    const ended = telnyxHangups(422, '90018');
    expect(
      await withAppDb((db) =>
        runCallMeter(db, spy.env, meter(u, callId, 'cutoff', 10), { now, fetch: ended.impl }),
      ),
    ).toBe('cut_off');
    expect((await cutoffAudits(u.orgId, callId))[0]?.metadata).toMatchObject({
      hangup: 'already_ended',
    });
  });
});

describe('settling an extended call', () => {
  it('charges the whole cost once and frees every hold', async () => {
    const u = await newUser('meter-settle');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    const { balance: before } = await totalsOf(u.orgId);
    const row = await callRow(callId);
    if (!row?.answeredAt || !row.providerCallId) throw new Error('not answered');

    // The provider's hangup at 14 min 30 s: 15 billed minutes, past the first hold.
    const hangupAt = new Date(row.answeredAt.getTime() + 14.5 * MINUTE);
    const hangup = (rawEventId: string) =>
      withAppDb((db) =>
        withTenant(db, u.orgId, (tx) =>
          applyToCall(
            tx,
            rawEventId,
            {
              kind: 'call',
              provider: 'fake',
              providerCallId: row.providerCallId as string,
              clientState: row.clientState,
              signal: { type: 'hangup', cause: 'normal' },
              direction: 'outbound',
              from: row.fromE164,
              to: row.toE164,
              occurredAt: hangupAt.toISOString(),
              billableSeconds: null,
              voicemail: null,
              orgHint: null,
            },
            callId,
            callBillingOf(workerEnv),
          ),
        ),
      );
    expect((await hangup(`test-hangup-${callId}`)).kind).toBe('applied');
    expect(await callRow(callId)).toMatchObject({ state: 'completed', costMicros: 15 * RATE });

    // Both closes are written in one transaction (same created_at): compare them by kind.
    const closes = (await holdsOf(u.orgId, callId))
      .filter((h) => h.kind !== 'reserve')
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(closes.map((h) => [h.kind, h.balanceDeltaMicros, h.heldDeltaMicros])).toEqual([
      ['capture', -15 * RATE, -10 * RATE],
      ['release', 0, -10 * RATE],
    ]);
    const { balance, held, lines } = await totalsOf(u.orgId);
    expect(balance).toBe(before - 15 * RATE);
    expect(held).toBe(0);
    assertLedgerInvariants(lines);

    // A late duplicate of the hangup changes nothing, and so does a late meter step.
    expect((await hangup(`test-hangup-2-${callId}`)).kind).toBe('applied');
    expect(
      await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 20), { now })),
    ).toBe('noop');
    expect(await totalsOf(u.orgId)).toMatchObject({ balance: before - 15 * RATE, held: 0 });
  });
});

describe('meter backstop', () => {
  it('extends a live call whose queued step never came', async () => {
    const u = await newUser('meter-backstop-extend');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 6);
    const spy = spyEnv();
    expect(await withAppDb((db) => meterLiveCalls(db, spy.env, u.orgId, { now }))).toEqual({
      checked: 1,
      failed: 0,
    });
    expect((await callRow(callId))?.paidMinutes).toBe(20);
  });

  it('leaves a call far from its paid time alone', async () => {
    const u = await newUser('meter-backstop-quiet');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 2);
    const spy = spyEnv();
    expect(await withAppDb((db) => meterLiveCalls(db, spy.env, u.orgId, { now }))).toEqual({
      checked: 0,
      failed: 0,
    });
    expect((await callRow(callId))?.paidMinutes).toBe(10);
  });

  it('cuts a call whose queued cut-off is late', async () => {
    const u = await newUser('meter-backstop-late');
    const callId = await dial(u);
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    await answered(callId, now, 9);
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    const later = new Date(now.getTime() + 2 * MINUTE);
    const swept = await sweepStaleCalls(spy.env, { now: later, orgIds: [u.orgId] });
    expect(swept).toEqual({ swept: 0, failed: 0, metered: 1 });
    expect(await callRow(callId)).toMatchObject({
      state: 'completed',
      hangupCause: 'cut_off',
      billableSeconds: 600,
    });
    expect((await cutoffAudits(u.orgId, callId))[0]?.metadata).toMatchObject({ via: 'backstop' });
  });

  it('cuts, without extending, a call that ran past its paid minutes', async () => {
    const u = await newUser('meter-backstop-over');
    const callId = await dial(u);
    const now = new Date();
    await answered(callId, now, 12);
    const spy = spyEnv();
    await withAppDb((db) => meterLiveCalls(db, spy.env, u.orgId, { now }));
    expect(await callRow(callId)).toMatchObject({
      state: 'completed',
      hangupCause: 'cut_off',
      cutoffReason: 'paid_time_over',
      billableSeconds: 600,
      costMicros: 10 * RATE,
    });
    expect(await holdsOf(u.orgId, callId)).toHaveLength(2);
    expect((await cutoffNotices(callId))[0]?.title).toBe(cutoffNotice('paid_time_over').title);
  });

  it('cuts at once when it has to warn after the cut-off time', async () => {
    const u = await newUser('meter-backstop-now');
    const callId = await dial(u);
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    // 9 min 55 s in: past paid time minus the margin, not yet past paid time.
    await answered(callId, now, 9 + 55 / 60);
    const spy = spyEnv();
    await withAppDb((db) => meterLiveCalls(db, spy.env, u.orgId, { now }));
    expect(await callRow(callId)).toMatchObject({ state: 'completed', hangupCause: 'cut_off' });
    expect(spy.sent).toEqual([]);
  });
});

describe('queue handlers', () => {
  function batch<T>(queue: string, bodies: T[]) {
    const acked: number[] = [];
    const retried: number[] = [];
    return {
      acked,
      retried,
      batch: {
        queue,
        messages: bodies.map((body, i) => ({
          id: `m${i}`,
          timestamp: new Date(),
          attempts: 1,
          body,
          ack: () => void acked.push(i),
          retry: () => void retried.push(i),
        })),
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch<T>,
    };
  }

  it('runs meter steps from the provider-events queue', async () => {
    const u = await newUser('meter-queue');
    const callId = await dial(u);
    await answered(callId, new Date(), 9);
    const spy = spyEnv();
    const b = batch('knoqra-provider-events', [meter(u, callId, 'extend', 10)]);
    await handleProviderEvents(b.batch, spy.env);
    expect(b.acked).toEqual([0]);
    expect((await callRow(callId))?.paidMinutes).toBe(20);
  });

  it('retries a step whose hang-up failed, and acks an unknown message', async () => {
    const u = await newUser('meter-queue-retry');
    const callId = await dial(u);
    await saveTelnyxCredential(u.orgId, '+12025550187');
    await leaveAvailable(u.orgId, 0);
    const now = new Date();
    await answered(callId, now, 9, `v3:${crypto.randomUUID()}`);
    await withAdminDb((db) =>
      db.update(call).set({ provider: 'telnyx' }).where(eq(call.id, callId)),
    );
    const spy = spyEnv();
    await withAppDb((db) => runCallMeter(db, spy.env, meter(u, callId, 'extend', 10), { now }));
    const b = batch('knoqra-provider-events', [meter(u, callId, 'cutoff', 10), { nope: true }]);
    await handleProviderEvents(b.batch as never, spy.env, { fetch: telnyxHangups(500).impl });
    expect(b.retried).toEqual([0]);
    expect(b.acked).toEqual([1]);
    expect((await callRow(callId))?.state).toBe('connected');
  });

  it('acks a dead-lettered meter step without touching the call', async () => {
    const u = await newUser('meter-dlq');
    const callId = await dial(u);
    const b = batch('knoqra-provider-events-dlq', [meter(u, callId, 'cutoff', 10)]);
    await handleDeadLetters(b.batch, workerEnv);
    expect(b.acked).toEqual([0]);
    expect((await callRow(callId))?.state).toBe('queued');
  });
});

describe('cut-off notices', () => {
  it('never carries a phone number or an amount', () => {
    for (const reason of ['insufficient_funds', 'stop_cap', 'paid_time_over'] as const) {
      const { title, body } = cutoffNotice(reason);
      expect(`${title} ${body}`).not.toMatch(/\d/);
    }
  });
});

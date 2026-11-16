import { env } from 'cloudflare:workers';
import { call, callEvent, ledgerEntry, timelineEvent, withTenant } from '@knoqra/db';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { findSweepOrgs, SWEPT_SIGNAL, sweepStaleCalls } from '../src/events/stale-calls';
import worker from '../src/index';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

/*
 * The stale-call sweep (ruling R29), driven directly: rows are backdated with the admin role, then
 * `sweepStaleCalls` runs with the test env, limited to the test's organizations so leftovers from
 * other runs in the shared database are not swept here.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type User = { cookie: string; orgId: string; userId: string };
type Created = { call: { id: string } };

const workerEnv = env as unknown as Env;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
      await post('/api/v1/contacts', u.cookie, { displayName: 'Sam Stale', phone: '+12025550124' }),
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
    idempotencyKey: `stale-${crypto.randomUUID()}`,
  });
  expect(r.status).toBe(201);
  return (await data<Created>(r)).call.id;
}

function backdate(
  callId: string,
  set: { state?: 'connected' | 'ringing'; answeredAt?: Date; updatedAt: Date },
) {
  return withAdminDb((db) => db.update(call).set(set).where(eq(call.id, callId)));
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

const timelineOf = (callId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(timelineEvent)
      .where(and(eq(timelineEvent.refType, 'call'), eq(timelineEvent.refId, callId))),
  );

const lockHolder = (userId: string) =>
  env.USER_CALL_LOCK.get(env.USER_CALL_LOCK.idFromName(userId)).current();

describe('stale-call sweep', () => {
  it('ends a pre-connect call idle for over 10 minutes as failed, releases its hold and frees the lock', async () => {
    const u = await newUser('sweep-pre');
    const callId = await dial(u);
    expect(await lockHolder(u.userId)).toBe(callId);
    const now = new Date();
    await backdate(callId, { state: 'ringing', updatedAt: new Date(now.getTime() - 11 * MINUTE) });

    const swept = await sweepStaleCalls(workerEnv, { now, orgIds: [u.orgId] });
    expect(swept).toEqual({ swept: 1, failed: 0 });

    expect(await callRow(callId)).toMatchObject({
      state: 'failed',
      hangupCause: 'failed',
      billableSeconds: 0,
      costMicros: 0,
    });
    const events = await eventsOf(callId);
    const sweepEvent = events.find((e) => e.signal === SWEPT_SIGNAL);
    expect(sweepEvent).toMatchObject({ stateBefore: 'ringing', stateAfter: 'failed' });
    expect(sweepEvent?.rawEventId).toBe(`sweep:${callId}:${now.getTime()}`);
    const settlements = await settlementsOf(u.orgId, callId);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'release', balanceDeltaMicros: 0 });
    expect(await timelineOf(callId)).toHaveLength(1);
    expect(await lockHolder(u.userId)).toBeNull();

    // A second run finds nothing left to sweep.
    expect(await sweepStaleCalls(workerEnv, { now, orgIds: [u.orgId] })).toEqual({
      swept: 0,
      failed: 0,
    });
    expect(await settlementsOf(u.orgId, callId)).toHaveLength(1);
  });

  it('captures a connected call idle for over 4 hours at the capped reserve duration', async () => {
    const u = await newUser('sweep-connected');
    const callId = await dial(u);
    const now = new Date();
    const fiveHoursAgo = new Date(now.getTime() - 5 * HOUR);
    await backdate(callId, {
      state: 'connected',
      answeredAt: fiveHoursAgo,
      updatedAt: fiveHoursAgo,
    });

    expect(await sweepStaleCalls(workerEnv, { now, orgIds: [u.orgId] })).toEqual({
      swept: 1,
      failed: 0,
    });

    // Capped at CALL_RESERVE_MINUTES (10) minutes: 600 s at the core's flat rate ($0.01) a minute.
    expect(await callRow(callId)).toMatchObject({
      state: 'failed',
      billableSeconds: 600,
      costMicros: 100_000,
    });
    const settlements = await settlementsOf(u.orgId, callId);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ kind: 'capture', balanceDeltaMicros: -100_000 });
    expect(await lockHolder(u.userId)).toBeNull();
  });

  it('leaves fresh calls alone: a new pre-connect call and a connected call idle for 1 hour', async () => {
    const u = await newUser('sweep-fresh');
    const fresh = await dial(u);
    const now = new Date();
    expect(await sweepStaleCalls(workerEnv, { now, orgIds: [u.orgId] })).toEqual({
      swept: 0,
      failed: 0,
    });
    const before = await callRow(fresh);
    expect(before?.endedAt).toBeNull();
    expect(await settlementsOf(u.orgId, fresh)).toHaveLength(0);
    expect(await lockHolder(u.userId)).toBe(fresh);

    const hourAgo = new Date(now.getTime() - HOUR);
    await backdate(fresh, { state: 'connected', answeredAt: hourAgo, updatedAt: hourAgo });
    expect(await sweepStaleCalls(workerEnv, { now, orgIds: [u.orgId] })).toEqual({
      swept: 0,
      failed: 0,
    });
    expect((await callRow(fresh))?.state).toBe('connected');
  });

  it('finds organizations with call routes from the last two days', async () => {
    const u = await newUser('sweep-orgs');
    await dial(u);
    const orgs = await withAppDb((db) => findSweepOrgs(db, new Date()));
    expect(orgs).toContain(u.orgId);
  });

  it('is wired as the Worker scheduled handler', () => {
    expect(typeof worker.scheduled).toBe('function');
  });
});

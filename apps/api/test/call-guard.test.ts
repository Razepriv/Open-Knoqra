import { env } from 'cloudflare:workers';
import {
  auditEvent,
  call,
  callRoute,
  member,
  notification,
  providerEventRaw,
  providerNumberRoute,
} from '@knoqra/db';
import { TelnyxWebhookAdapter } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { blockedNotice, sameDestination } from '../src/events/call-guard';
import { logger } from '../src/lib/logger';
import { handleProviderEvents } from '../src/queue/consumer';
import { emergencyFastPath, ingestWebhook } from '../src/routes/webhooks';
import { get, saveTelnyxCredential, signUp, uniqueEmail, withAdminDb } from './helpers';

/*
 * The call guard end to end, without the Workers queue: a signed Telnyx `call.initiated` goes
 * through `ingestWebhook` with a recording queue double, then `handleProviderEvents` gets a
 * hand-built batch. Telnyx's hang-up endpoint is a fetch stand-in (no network in tests).
 */

afterEach(() => vi.restoreAllMocks());

type Envelope<T> = { data: T | null };
type Workspace = { orgId: string; userId: string; number: string };

/** saveTelnyxCredential's connection id. */
const CONNECTION_ID = '1234567890';

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
};
const adapter = new TelnyxWebhookAdapter({
  publicKeyBase64: toBase64(
    new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer),
  ),
});

async function signedHeaders(body: Uint8Array): Promise<Headers> {
  const timestamp = Math.floor(Date.now() / 1000);
  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message);
  return new Headers({
    'telnyx-signature-ed25519': toBase64(new Uint8Array(sig)),
    'telnyx-timestamp': String(timestamp),
  });
}

const randomDigits = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String(b % 10)).join('');
const usNumber = () => `+1202555${randomDigits(4)}`;
const callControlId = () => `v3:${crypto.randomUUID()}`;

async function workspace(label: string): Promise<Workspace> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  const number = usNumber();
  await saveTelnyxCredential(orgId, number);
  await withAdminDb(async (db) => {
    await db
      .delete(providerNumberRoute)
      .where(and(eq(providerNumberRoute.provider, 'telnyx'), eq(providerNumberRoute.e164, number)));
    await db
      .insert(providerNumberRoute)
      .values({ provider: 'telnyx', e164: number, organizationId: orgId });
  });
  return { orgId, userId, number };
}

/** A call the API authorized (as POST /calls leaves it): queued, unbound, with its route. */
async function authorizedCall(ws: Workspace, to: string, clientState = crypto.randomUUID()) {
  const id = `cl_${crypto.randomUUID().replace(/-/g, '')}`;
  await withAdminDb(async (db) => {
    await db.insert(call).values({
      id,
      organizationId: ws.orgId,
      userId: ws.userId,
      direction: 'outbound',
      state: 'queued',
      fromE164: ws.number,
      toE164: to,
      provider: 'telnyx',
      clientState,
      idempotencyKey: `idem_${id}`,
    });
    await db
      .insert(callRoute)
      .values({ clientState, organizationId: ws.orgId, callId: id, provider: 'telnyx' });
  });
  return { id, clientState };
}

interface Initiated {
  id: string;
  to: string;
  from: string;
  clientState?: string | null;
  direction?: 'outgoing' | 'incoming' | null;
  connectionId?: string;
}

function initiated(spec: Initiated): string {
  const payload: Record<string, unknown> = {
    call_control_id: spec.id,
    call_leg_id: `leg-${spec.id}`,
    call_session_id: `session-${spec.id}`,
    client_state: spec.clientState ? btoa(spec.clientState) : null,
    connection_id: spec.connectionId ?? CONNECTION_ID,
    from: spec.from,
    to: spec.to,
    state: 'parked',
    start_time: new Date().toISOString(),
  };
  if (spec.direction !== null) payload.direction = spec.direction ?? 'outgoing';
  return JSON.stringify({
    data: {
      id: crypto.randomUUID(),
      event_type: 'call.initiated',
      occurred_at: new Date().toISOString(),
      record_type: 'event',
      payload,
    },
  });
}

/** A Telnyx hang-up stand-in: answers each hang-up with the next status (the last one repeats). */
function telnyxHangups(...statuses: { status: number; code?: string }[]) {
  const hungUp: string[] = [];
  const other: string[] = [];
  const answers = statuses.length > 0 ? statuses : [{ status: 200 }];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const match = /^\/v2\/calls\/([^/]+)\/actions\/hangup$/.exec(url.pathname);
    if (!match || init?.method !== 'POST') {
      other.push(url.pathname);
      return new Response('{}', { status: 500 });
    }
    hungUp.push(decodeURIComponent(match[1] as string));
    const answer = answers[Math.min(hungUp.length, answers.length) - 1] ?? { status: 200 };
    if (answer.status === 200) {
      return Response.json({ data: { result: 'ok' } });
    }
    return Response.json({ errors: [{ code: answer.code ?? '10001' }] }, { status: answer.status });
  }) as typeof fetch;
  return { impl, hungUp, other };
}

function queueSpy() {
  const sent: string[] = [];
  const over = {
    PROVIDER_EVENTS: { send: async (m: { rawEventId: string }) => void sent.push(m.rawEventId) },
  };
  return { sent, env: { ...(env as unknown as Env), ...over } as unknown as Env };
}

async function ingest(
  body: string,
  opts: Parameters<typeof ingestWebhook>[4] = {},
): Promise<string> {
  const spy = queueSpy();
  const bytes = new TextEncoder().encode(body);
  const result = await ingestWebhook(spy.env, adapter, await signedHeaders(bytes), bytes, opts);
  expect(result).toEqual({ status: 200, duplicate: false });
  const rawEventId = spy.sent[0];
  if (!rawEventId) throw new Error('nothing queued');
  return rawEventId;
}

async function consume(rawEventId: string, fetchImpl: typeof fetch) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: 'knoqra-provider-events',
    messages: [
      {
        id: rawEventId,
        timestamp: new Date(),
        attempts: 1,
        body: { rawEventId },
        ack: () => acked.push(rawEventId),
        retry: () => retried.push(rawEventId),
      },
    ],
  } as unknown as MessageBatch<{ rawEventId: string }>;
  await handleProviderEvents(batch, env as unknown as Env, { fetch: fetchImpl });
  return { acked, retried };
}

const rawRow = async (id: string) =>
  (
    await withAdminDb((db) => db.select().from(providerEventRaw).where(eq(providerEventRaw.id, id)))
  )[0];

const blockedAudits = (orgId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.action, 'call.blocked'))),
  );

const notificationsOf = (orgId: string) =>
  withAdminDb((db) => db.select().from(notification).where(eq(notification.organizationId, orgId)));

const callsOf = (orgId: string) =>
  withAdminDb((db) => db.select().from(call).where(eq(call.organizationId, orgId)));

describe('call guard: emergency calls', () => {
  it('hangs up an outbound call to 911 once, records it and notifies the owner', async () => {
    const ws = await workspace('guard-911');
    const id = callControlId();
    const rawEventId = await ingest(initiated({ id, to: '911', from: ws.number }));
    const telnyx = telnyxHangups();

    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([id]);
    expect(await rawRow(rawEventId)).toMatchObject({ status: 'processed' });

    const audits = await blockedAudits(ws.orgId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'denied',
      actorUserId: null,
      entityType: 'call',
      metadata: { reason: 'emergency', code: '911', provider: 'telnyx', providerCallId: id },
    });
    expect(JSON.stringify(audits[0]?.metadata)).not.toContain(ws.number);

    const notes = await notificationsOf(ws.orgId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: ws.userId,
      kind: 'system',
      title: "A call to 911 was blocked: KNOQRA can't place emergency calls.",
    });
    // No call row and therefore no charge.
    expect(await callsOf(ws.orgId)).toEqual([]);

    // A redelivery of the same queue message is a no-op: no second hang-up, no second record.
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([id]);
    expect(await blockedAudits(ws.orgId)).toHaveLength(1);
    expect(await notificationsOf(ws.orgId)).toHaveLength(1);
  });

  it('hangs up 911 dialed as a SIP URI even with the client state of an authorized call', async () => {
    const ws = await workspace('guard-911-state');
    const authorized = await authorizedCall(ws, '+12025550123');
    const id = callControlId();
    const rawEventId = await ingest(
      initiated({
        id,
        to: 'sip:+1911@sip.telnyx.com',
        from: ws.number,
        clientState: authorized.clientState,
      }),
    );
    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([id]);
    expect((await blockedAudits(ws.orgId))[0]?.metadata).toMatchObject({ reason: 'emergency' });
    // The authorized call is left as it was: not bound to the blocked call.
    const [row] = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.id, authorized.id)),
    );
    expect(row).toMatchObject({ providerCallId: null, state: 'queued' });
  });

  it('cuts an emergency call from the webhook fast path, and the queue then does nothing', async () => {
    const ws = await workspace('guard-fast');
    const id = callControlId();
    const telnyx = telnyxHangups();
    const tasks: Promise<unknown>[] = [];
    const rawEventId = await ingest(initiated({ id, to: '112', from: ws.number }), {
      afterStore: emergencyFastPath(env as unknown as Env, null, {
        waitUntil: (p) => tasks.push(p),
        fetch: telnyx.impl,
      }),
    });
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(telnyx.hungUp).toEqual([id]);
    expect(await rawRow(rawEventId)).toMatchObject({ status: 'processed' });
    expect(await blockedAudits(ws.orgId)).toHaveLength(1);

    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([id]);
    expect(await blockedAudits(ws.orgId)).toHaveLength(1);
    expect(await notificationsOf(ws.orgId)).toHaveLength(1);
  });

  it('leaves every other event to the queue: the fast path schedules nothing', async () => {
    const ws = await workspace('guard-fast-skip');
    const tasks: Promise<unknown>[] = [];
    const afterStore = emergencyFastPath(env as unknown as Env, null, {
      waitUntil: (p) => tasks.push(p),
    });
    await ingest(initiated({ id: callControlId(), to: '+12025550123', from: ws.number }), {
      afterStore,
    });
    await ingest(
      initiated({ id: callControlId(), to: '911', from: ws.number, direction: 'incoming' }),
      { afterStore },
    );
    expect(tasks).toEqual([]);
  });
});

describe('call guard: calls the API did not authorize', () => {
  it('hangs up an outbound call without a client state, with a neutral notice', async () => {
    const ws = await workspace('guard-nostate');
    const id = callControlId();
    const rawEventId = await ingest(initiated({ id, to: '+442079460958', from: ws.number }));
    const telnyx = telnyxHangups();
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([id]);
    expect((await blockedAudits(ws.orgId))[0]?.metadata).toMatchObject({ reason: 'unauthorized' });
    const [note] = await notificationsOf(ws.orgId);
    expect(note?.title).toBe(blockedNotice('unauthorized', null).title);
    expect(note?.title).not.toMatch(/911|emergency/i);
    expect(await callsOf(ws.orgId)).toEqual([]);
  });

  it('hangs up a call that reuses an authorized client state for another number', async () => {
    const ws = await workspace('guard-reuse');
    const authorized = await authorizedCall(ws, '+12025550123');
    const id = callControlId();
    const rawEventId = await ingest(
      initiated({ id, to: '+442079460958', from: ws.number, clientState: authorized.clientState }),
    );
    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([id]);
    expect((await blockedAudits(ws.orgId))[0]?.metadata).toMatchObject({ reason: 'unauthorized' });
  });

  it('hangs up a call that carries the client state of an inbound call', async () => {
    const ws = await workspace('guard-inbound-state');
    const clientState = crypto.randomUUID();
    await withAdminDb(async (db) => {
      const callId = `cl_${crypto.randomUUID().replace(/-/g, '')}`;
      await db.insert(call).values({
        id: callId,
        organizationId: ws.orgId,
        userId: ws.userId,
        direction: 'inbound',
        state: 'ringing',
        fromE164: '+12025550123',
        toE164: ws.number,
        provider: 'telnyx',
        clientState,
      });
      await db
        .insert(callRoute)
        .values({ clientState, organizationId: ws.orgId, callId, provider: 'telnyx' });
    });
    const id = callControlId();
    const rawEventId = await ingest(
      initiated({ id, to: '+12025550123', from: ws.number, clientState }),
    );
    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([id]);
  });
});

describe('call guard: calls it must never touch', () => {
  it('leaves an API-created outbound call to the call handler', async () => {
    const ws = await workspace('guard-api');
    const authorized = await authorizedCall(ws, '+12025550123');
    const id = callControlId();
    const rawEventId = await ingest(
      initiated({ id, to: '+12025550123', from: ws.number, clientState: authorized.clientState }),
    );
    const telnyx = telnyxHangups();
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([]);
    expect(telnyx.other).toEqual([]);
    const [row] = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.id, authorized.id)),
    );
    expect(row?.providerCallId).toBe(id);
    expect(await blockedAudits(ws.orgId)).toEqual([]);
    expect(await notificationsOf(ws.orgId)).toEqual([]);
  });

  it('leaves a call the API authorized moments ago when Telnyx omits its client state', async () => {
    const ws = await workspace('guard-pending');
    await authorizedCall(ws, '+12025550123');
    const rawEventId = await ingest(
      initiated({ id: callControlId(), to: '+12025550123', from: ws.number }),
    );
    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([]);
    expect(await blockedAudits(ws.orgId)).toEqual([]);
    // As before the guard: the call handler parks it until an event with the client state binds it.
    expect(await rawRow(rawEventId)).toMatchObject({
      status: 'parked',
      parkReason: 'unknown_call',
    });
  });

  it('leaves an inbound call alone, even to an emergency-looking number', async () => {
    const ws = await workspace('guard-inbound');
    const telnyx = telnyxHangups();
    const ringing = await ingest(
      initiated({
        id: callControlId(),
        to: ws.number,
        from: '+12025550123',
        direction: 'incoming',
      }),
    );
    expect(await consume(ringing, telnyx.impl)).toEqual({ acked: [ringing], retried: [] });
    const odd = await ingest(
      initiated({ id: callControlId(), to: '911', from: ws.number, direction: 'incoming' }),
    );
    await consume(odd, telnyx.impl);
    expect(telnyx.hungUp).toEqual([]);
    expect(await blockedAudits(ws.orgId)).toEqual([]);
    const calls = await callsOf(ws.orgId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ direction: 'inbound', state: 'ringing' });
  });

  it('never acts on a call.initiated without a direction', async () => {
    const ws = await workspace('guard-nodirection');
    const rawEventId = await ingest(
      initiated({ id: callControlId(), to: '911', from: ws.number, direction: null }),
    );
    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([]);
    expect(await blockedAudits(ws.orgId)).toEqual([]);
  });

  it('never acts for another workspace when the caller id is spoofed', async () => {
    const victim = await workspace('guard-victim');
    const errors = vi.spyOn(logger, 'error');
    const rawEventId = await ingest(
      initiated({ id: callControlId(), to: '911', from: victim.number, connectionId: '999' }),
    );
    const telnyx = telnyxHangups();
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([]);
    expect(await blockedAudits(victim.orgId)).toEqual([]);
    expect(await notificationsOf(victim.orgId)).toEqual([]);
    expect(errors).toHaveBeenCalledWith('call_guard.no_workspace', expect.anything());
  });
});

describe('call guard: when the hang-up fails', () => {
  it('retries a failed hang-up, logs it, and records the block once it succeeds', async () => {
    const ws = await workspace('guard-retry');
    const id = callControlId();
    const rawEventId = await ingest(initiated({ id, to: '911', from: ws.number }));
    const telnyx = telnyxHangups({ status: 503 }, { status: 200 });
    const errors = vi.spyOn(logger, 'error');

    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [], retried: [rawEventId] });
    expect(errors).toHaveBeenCalledWith(
      'queue.process_failed',
      expect.objectContaining({ rawEventId }),
    );
    expect(await blockedAudits(ws.orgId)).toEqual([]);
    expect(await rawRow(rawEventId)).toMatchObject({ status: 'pending', attempts: 1 });

    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(telnyx.hungUp).toEqual([id, id]);
    expect(await blockedAudits(ws.orgId)).toHaveLength(1);
  });

  it('records a call that had already ended when the hang-up reached Telnyx', async () => {
    const ws = await workspace('guard-ended');
    const rawEventId = await ingest(initiated({ id: callControlId(), to: '911', from: ws.number }));
    const telnyx = telnyxHangups({ status: 422, code: '90018' });
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect((await blockedAudits(ws.orgId))[0]?.metadata).toMatchObject({ hangup: 'already_ended' });
  });

  it('logs a permanent refusal and stops retrying it', async () => {
    const ws = await workspace('guard-refused');
    const rawEventId = await ingest(initiated({ id: callControlId(), to: '911', from: ws.number }));
    const telnyx = telnyxHangups({ status: 403 });
    const errors = vi.spyOn(logger, 'error');
    expect(await consume(rawEventId, telnyx.impl)).toEqual({ acked: [rawEventId], retried: [] });
    expect(errors).toHaveBeenCalledWith(
      'call_guard.hangup_refused',
      expect.objectContaining({ status: 403 }),
    );
    expect(await rawRow(rawEventId)).toMatchObject({ status: 'ignored' });
    expect(await blockedAudits(ws.orgId)).toEqual([]);
  });

  it('never throws from the fast path: a failure there is left to the queue', async () => {
    const ws = await workspace('guard-fast-fail');
    const id = callControlId();
    const failing = telnyxHangups({ status: 503 });
    const tasks: Promise<unknown>[] = [];
    const rawEventId = await ingest(initiated({ id, to: '911', from: ws.number }), {
      afterStore: emergencyFastPath(env as unknown as Env, null, {
        waitUntil: (p) => tasks.push(p),
        fetch: failing.impl,
      }),
    });
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    expect(await rawRow(rawEventId)).toMatchObject({ status: 'pending' });

    const telnyx = telnyxHangups();
    await consume(rawEventId, telnyx.impl);
    expect(telnyx.hungUp).toEqual([id]);
    expect(await blockedAudits(ws.orgId)).toHaveLength(1);
  });
});

describe('sameDestination', () => {
  it.each([
    ['+12025550123', '+12025550123', true],
    ['+12025550123', '12025550123', true],
    ['+12025550123', '2025550123', true],
    ['+12025550123', 'sip:+12025550123@sip.telnyx.com', true],
    ['+12025550123', '+12025550124', false],
    ['+12025550123', '0123', false],
    ['+12025550123', '', false],
  ])('%j and %j: %j', (a, b, same) => {
    expect(sameDestination(a, b)).toBe(same);
  });
});

describe('the owner list', () => {
  it('notifies every owner of the workspace', async () => {
    const ws = await workspace('guard-owners');
    const owners = await withAdminDb((db) =>
      db.select().from(member).where(eq(member.organizationId, ws.orgId)),
    );
    const rawEventId = await ingest(initiated({ id: callControlId(), to: '988', from: ws.number }));
    await consume(rawEventId, telnyxHangups().impl);
    const notes = await notificationsOf(ws.orgId);
    expect(notes.map((n) => n.userId).sort()).toEqual(owners.map((o) => o.userId).sort());
    expect(notes[0]?.title).toBe("A call to 988 was blocked: KNOQRA can't place emergency calls.");
  });
});

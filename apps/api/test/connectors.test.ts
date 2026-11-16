import { env } from 'cloudflare:workers';
import {
  auditEvent,
  call,
  callRoute,
  member,
  providerCredential,
  providerEventRaw,
  providerNumberRoute,
} from '@knoqra/db';
import {
  encodeForm,
  NONCE_HEADER,
  PlivoWebhookAdapter,
  SIGNATURE_HEADER,
  signPlivoV3,
} from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { handleProviderEvents } from '../src/queue/consumer';
import { ingestWebhook } from '../src/routes/webhooks';
import { get, signUp, signUpTeammate, uniqueEmail, withAdminDb } from './helpers';

const executionCtx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Connection = {
  provider: 'telnyx' | 'plivo';
  last4: string;
  accountId: string | null;
  connectionId: string | null;
  callerIdE164: string | null;
  webhook: { events: string; answer: string | null; absolute: boolean; ownKey: boolean };
  check: { status: string; checkedAt: string } | null;
};
type Connectors = {
  providers: { id: string; liveVerified: boolean; fields: { name: string; secret: boolean }[] }[];
  connection: Connection | null;
};

const API_HOST = 'https://api.example.test';
const TELNYX_KEY = 'KEY0TESTONLY1234567890abcdef';
const PLIVO_TOKEN = 'plivotestonlytoken0000000000000000000000';
const PLIVO_AUTH_ID = 'MATESTONLYAUTHID0000';
/** Numbers no other suite uses (provider_number_route is shared). */
const N = (n: number) => `+120255501${n}`;
const USED = [81, 82, 83, 84, 85, 86, 87, 88, 89].map(N);

const baseEnv = env as unknown as Env;
const liveEnv = { ...baseEnv, PROVIDER: 'connectors' } as Env;

const clearRoutes = () =>
  withAdminDb((db) =>
    db.delete(providerNumberRoute).where(inArray(providerNumberRoute.e164, USED)),
  );

// Another suite in the shared database may have left one of these numbers routed: start clean.
beforeAll(clearRoutes);

afterAll(async () => {
  await withAdminDb((db) =>
    db.delete(providerNumberRoute).where(inArray(providerNumberRoute.e164, USED)),
  );
});

function request(path: string, init: RequestInit = {}, over: Partial<Env> = {}) {
  const url = path.startsWith('http') ? path : `${API_HOST}${path}`;
  return app.request(url, init, { ...liveEnv, ...over } as Env, executionCtx);
}

function send(method: 'PUT' | 'DELETE', path: string, cookie: string, body?: unknown, over = {}) {
  return request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    over,
  );
}

async function newOwner(label: string): Promise<{ cookie: string; orgId: string }> {
  const cookie = await signUp(uniqueEmail(label));
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = me.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

async function connectors(cookie: string, over: Partial<Env> = {}): Promise<Connectors> {
  const r = await request('/api/v1/connectors', { headers: { cookie } }, over);
  expect(r.status).toBe(200);
  const body = (await r.json()) as Envelope<Connectors>;
  if (!body.data) throw new Error('no data');
  return body.data;
}

const plivoBody = (callerIdE164: string, over: Record<string, unknown> = {}) => ({
  authId: PLIVO_AUTH_ID,
  authToken: PLIVO_TOKEN,
  appId: '29986316244302815',
  callerIdE164,
  ...over,
});

const telnyxBody = (callerIdE164: string, over: Record<string, unknown> = {}) => ({
  apiKey: TELNYX_KEY,
  connectionId: '1234567890',
  callerIdE164,
  ...over,
});

const storedRow = (orgId: string) =>
  withAdminDb(async (db) => {
    const [row] = await db
      .select()
      .from(providerCredential)
      .where(eq(providerCredential.organizationId, orgId));
    return row;
  });

describe('GET /api/v1/connectors', () => {
  it('lists the offered providers with their fields and no connection for a new workspace', async () => {
    const { cookie } = await newOwner('conn-list');
    const data = await connectors(cookie);
    expect(data.connection).toBeNull();
    expect(data.providers.map((p) => p.id)).toEqual(['telnyx', 'plivo']);
    const plivo = data.providers.find((p) => p.id === 'plivo');
    expect(plivo?.liveVerified).toBe(false);
    expect(plivo?.fields.filter((f) => f.secret).map((f) => f.name)).toEqual(['authToken']);
  });

  it('offers only live-verified providers in production unless CONNECTORS says otherwise', async () => {
    const { cookie } = await newOwner('conn-prod');
    const prod = { APP_ENV: 'production' } as const;
    expect((await connectors(cookie, prod)).providers.map((p) => p.id)).toEqual(['telnyx']);
    expect(
      (await connectors(cookie, { ...prod, CONNECTORS: 'telnyx, plivo' })).providers.map(
        (p) => p.id,
      ),
    ).toEqual(['telnyx', 'plivo']);
    const refused = await send('PUT', '/api/v1/connectors/plivo', cookie, plivoBody(N(81)), prod);
    expect(refused.status).toBe(404);
  });

  it('requires a session', async () => {
    expect((await request('/api/v1/connectors')).status).toBe(401);
  });
});

describe('PUT and DELETE /api/v1/connectors/plivo', () => {
  it('seals the auth token, shows only its last four and the webhook URLs, and audits', async () => {
    const { cookie, orgId } = await newOwner('conn-plivo');
    const r = await send('PUT', '/api/v1/connectors/plivo', cookie, plivoBody(N(82)), {
      API_PUBLIC_ORIGIN: 'https://api.knoqra.test/',
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toContain(PLIVO_TOKEN);
    const saved = (JSON.parse(text) as Envelope<Connection>).data;
    expect(saved).toMatchObject({
      provider: 'plivo',
      last4: PLIVO_TOKEN.slice(-4),
      accountId: PLIVO_AUTH_ID,
      connectionId: '29986316244302815',
      callerIdE164: N(82),
      webhook: {
        events: `https://api.knoqra.test/webhooks/plivo/${orgId}`,
        answer: `https://api.knoqra.test/webhooks/plivo/${orgId}/answer`,
        absolute: true,
        ownKey: true,
      },
      check: null,
    });
    const row = await storedRow(orgId);
    expect(row?.apiKeyCiphertext).not.toContain(PLIVO_TOKEN);
    // Without a public origin the Desk gets the paths.
    expect((await connectors(cookie)).connection?.webhook).toMatchObject({
      events: `/webhooks/plivo/${orgId}`,
      absolute: false,
    });
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgId),
            eq(auditEvent.action, 'voice.connection.update'),
          ),
        ),
    );
    expect(audits.map((a) => a.metadata)).toEqual([
      { provider: 'plivo', last4: PLIVO_TOKEN.slice(-4) },
    ]);

    const removed = await send('DELETE', '/api/v1/connectors/plivo', cookie);
    expect(removed.status).toBe(204);
    expect(await storedRow(orgId)).toBeUndefined();
    expect((await connectors(cookie)).connection).toBeNull();
  });

  it('refuses a second provider while one is connected, and changes nothing', async () => {
    const { cookie, orgId } = await newOwner('conn-conflict');
    expect((await send('PUT', '/api/v1/connectors/telnyx', cookie, telnyxBody(N(83)))).status).toBe(
      200,
    );
    const r = await send('PUT', '/api/v1/connectors/plivo', cookie, plivoBody(N(83)));
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'connector_conflict',
      message: 'This workspace is connected to Telnyx. Disconnect Telnyx first.',
    });
    expect((await storedRow(orgId))?.provider).toBe('telnyx');
    // The older Telnyx-only route refuses the other way round too.
    expect((await send('DELETE', '/api/v1/connectors/telnyx', cookie)).status).toBe(204);
    expect((await send('PUT', '/api/v1/connectors/plivo', cookie, plivoBody(N(83)))).status).toBe(
      200,
    );
    const legacy = await send('PUT', '/api/v1/voice/connection', cookie, telnyxBody(N(83)));
    expect(legacy.status).toBe(409);
    expect((await (await get('/api/v1/voice/connection', cookie)).json()) as unknown).toMatchObject(
      { data: null },
    );
  });

  it('validates the Plivo fields', async () => {
    const { cookie } = await newOwner('conn-invalid');
    for (const bad of [
      { authId: 'short' },
      { authToken: 'has spaces in it but is long enough' },
      { appId: 'not/an/id' },
      { callerIdE164: 'not a number' },
    ]) {
      const r = await send('PUT', '/api/v1/connectors/plivo', cookie, plivoBody(N(84), bad));
      expect(r.status).toBe(400);
    }
  });

  it('lets only owners and admins connect and disconnect', async () => {
    const { orgId } = await newOwner('conn-role');
    const mate = await signUpTeammate(orgId);
    expect(
      (await send('PUT', '/api/v1/connectors/plivo', mate.cookie, plivoBody(N(85)))).status,
    ).toBe(403);
    expect((await send('DELETE', '/api/v1/connectors/plivo', mate.cookie)).status).toBe(403);
    expect(await storedRow(orgId)).toBeUndefined();
    // Members still see the status.
    expect((await connectors(mate.cookie)).connection).toBeNull();
  });
});

// --- per-connection webhooks ---------------------------------------------------------------------

type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

async function telnyxKeys() {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as KeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  return { keys, publicKeyBase64: toBase64(raw) };
}

async function telnyxHeaders(keys: KeyPair, body: Uint8Array) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, message);
  return {
    'telnyx-signature-ed25519': toBase64(new Uint8Array(sig)),
    'telnyx-timestamp': timestamp,
  };
}

function queueSpy() {
  const sent: string[] = [];
  const queue = { send: async (m: { rawEventId: string }) => void sent.push(m.rawEventId) };
  return { sent, over: { PROVIDER_EVENTS: queue } as unknown as Partial<Env> };
}

const telnyxEvent = (id: string) =>
  JSON.stringify({
    data: {
      id,
      event_type: 'call.hangup',
      occurred_at: new Date().toISOString(),
      payload: { call_control_id: `v3:${id}`, hangup_cause: 'normal_clearing' },
    },
  });

const rawById = (id: string) =>
  withAdminDb(async (db) => {
    const [row] = await db.select().from(providerEventRaw).where(eq(providerEventRaw.id, id));
    return row;
  });

describe('Telnyx per-connection webhooks', () => {
  it('verifies with the connection’s own public key and stores the delivery for that workspace', async () => {
    const { cookie, orgId } = await newOwner('conn-tx-hook');
    const { keys, publicKeyBase64 } = await telnyxKeys();
    const saved = await send(
      'PUT',
      '/api/v1/connectors/telnyx',
      cookie,
      telnyxBody(N(86), { webhookPublicKey: publicKeyBase64 }),
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as Envelope<Connection>).data?.webhook).toMatchObject({
      events: `/webhooks/telnyx/${orgId}`,
      ownKey: true,
    });

    const id = crypto.randomUUID();
    const body = new TextEncoder().encode(telnyxEvent(id));
    const spy = queueSpy();
    const r = await request(
      `/webhooks/telnyx/${orgId}`,
      { method: 'POST', headers: await telnyxHeaders(keys, body), body },
      spy.over,
    );
    expect(r.status).toBe(200);
    expect(spy.sent).toHaveLength(1);
    const raw = await rawById(spy.sent[0] as string);
    expect(raw).toMatchObject({ organizationId: orgId, externalEventId: `${orgId}:${id}` });

    // Another key, another workspace's URL, or a workspace with no key: all 401.
    const other = await telnyxKeys();
    const forged = await request(
      `/webhooks/telnyx/${orgId}`,
      { method: 'POST', headers: await telnyxHeaders(other.keys, body), body },
      spy.over,
    );
    expect(forged.status).toBe(401);
    const stranger = await newOwner('conn-tx-none');
    const noConnection = await request(
      `/webhooks/telnyx/${stranger.orgId}`,
      { method: 'POST', headers: await telnyxHeaders(keys, body), body },
      spy.over,
    );
    expect(noConnection.status).toBe(401);
    expect(spy.sent).toHaveLength(1);
  });

  it('keeps the platform URL for a connection without its own key', async () => {
    const { cookie, orgId } = await newOwner('conn-tx-platform');
    const saved = await send('PUT', '/api/v1/connectors/telnyx', cookie, telnyxBody(N(87)));
    expect(((await saved.json()) as Envelope<Connection>).data?.webhook).toMatchObject({
      events: '/webhooks/telnyx',
      ownKey: false,
    });
    const { keys } = await telnyxKeys();
    const body = new TextEncoder().encode(telnyxEvent(crypto.randomUUID()));
    const r = await request(`/webhooks/telnyx/${orgId}`, {
      method: 'POST',
      headers: await telnyxHeaders(keys, body),
      body,
    });
    expect(r.status).toBe(401);
  });
});

async function plivoHeaders(url: string, body: Uint8Array, token = PLIVO_TOKEN) {
  const nonce = String(Date.now());
  const signature = await signPlivoV3({ url, nonce, authToken: token, body });
  return { [SIGNATURE_HEADER]: signature ?? '', [NONCE_HEADER]: nonce };
}

async function plivoOwner(label: string, callerId: string) {
  const owner = await newOwner(label);
  const r = await send('PUT', '/api/v1/connectors/plivo', owner.cookie, plivoBody(callerId));
  expect(r.status).toBe(200);
  return owner;
}

const hangup = (callUuid: string) =>
  encodeForm({
    CallUUID: callUuid,
    Event: 'Hangup',
    CallStatus: 'completed',
    HangupCauseName: 'Normal Hangup',
    From: 'sip:knoqra@phone.plivo.com',
    To: '12025550123',
  });

describe('Plivo per-connection webhooks', () => {
  it('verifies X-Plivo-Signature-V3 over the exact URL with the stored auth token', async () => {
    const { orgId } = await plivoOwner('conn-pl-hook', N(88));
    const url = `${API_HOST}/webhooks/plivo/${orgId}`;
    const body = hangup(crypto.randomUUID());
    const spy = queueSpy();
    const ok = await request(
      url,
      { method: 'POST', headers: await plivoHeaders(url, body), body },
      spy.over,
    );
    expect(ok.status).toBe(200);
    expect(spy.sent).toHaveLength(1);
    expect(await rawById(spy.sent[0] as string)).toMatchObject({
      provider: 'plivo',
      organizationId: orgId,
      eventType: 'call.completed',
    });
    for (const headers of [
      await plivoHeaders(url, body, `${PLIVO_TOKEN}x`),
      await plivoHeaders(`${url}/other`, body),
      {},
    ]) {
      const r = await request(url, { method: 'POST', headers, body }, spy.over);
      expect(r.status).toBe(401);
    }
    expect(spy.sent).toHaveLength(1);
  });

  it('never applies an event signed by one workspace to another workspace’s number', async () => {
    const a = await plivoOwner('conn-pl-guard-a', N(89));
    const b = await newOwner('conn-pl-guard-b');
    const victimNumber = N(84);
    await withAdminDb((db) =>
      db
        .insert(providerNumberRoute)
        .values({ provider: 'plivo', e164: victimNumber, organizationId: b.orgId })
        .onConflictDoNothing(),
    );
    const url = `${API_HOST}/webhooks/plivo/${a.orgId}`;
    const body = encodeForm({
      CallUUID: crypto.randomUUID(),
      Event: 'StartApp',
      Direction: 'inbound',
      From: '12025550123',
      To: victimNumber.slice(1),
      CallStatus: 'ringing',
    });
    const adapter = new PlivoWebhookAdapter({ authToken: PLIVO_TOKEN, url });
    const spy = queueSpy();
    const result = await ingestWebhook(
      { ...liveEnv, ...spy.over } as Env,
      adapter,
      new Headers(await plivoHeaders(url, body)),
      body,
      { organizationId: a.orgId },
    );
    expect(result.status).toBe(200);
    const rawEventId = spy.sent[0] as string;
    const acked: string[] = [];
    await handleProviderEvents(
      {
        queue: 'knoqra-provider-events',
        messages: [{ body: { rawEventId }, ack: () => acked.push(rawEventId), retry: () => {} }],
      } as unknown as MessageBatch<{ rawEventId: string }>,
      liveEnv,
    );
    expect(acked).toEqual([rawEventId]);
    expect(await rawById(rawEventId)).toMatchObject({ status: 'ignored' });
    const victimCalls = await withAdminDb((db) =>
      db.select().from(call).where(eq(call.organizationId, b.orgId)),
    );
    expect(victimCalls).toEqual([]);
  });
});

describe('Plivo answer URL', () => {
  async function authorizedCall(orgId: string, clientState: string, to: string, state = 'queued') {
    const userId = await withAdminDb(async (db) => {
      const [m] = await db.select().from(member).where(eq(member.organizationId, orgId));
      return m?.userId as string;
    });
    const id = `cl_${crypto.randomUUID().replace(/-/g, '')}`;
    await withAdminDb(async (db) => {
      await db.insert(call).values({
        id,
        organizationId: orgId,
        userId,
        direction: 'outbound',
        state: state as 'queued',
        fromE164: N(81),
        toE164: to,
        provider: 'plivo',
        clientState,
        idempotencyKey: `idem_${id}`,
      });
      await db
        .insert(callRoute)
        .values({ clientState, organizationId: orgId, callId: id, provider: 'plivo' });
    });
    return id;
  }

  const answerBody = (clientState: string | null, to: string) =>
    encodeForm({
      CallUUID: crypto.randomUUID(),
      Event: 'StartApp',
      Direction: 'inbound',
      From: 'sip:knoqra0001@phone.plivo.com',
      To: to,
      CallStatus: 'in-progress',
      ...(clientState === null ? {} : { 'X-PH-ClientState': clientState }),
    });

  async function answer(orgId: string, body: Uint8Array, signed = true) {
    const url = `${API_HOST}/webhooks/plivo/${orgId}/answer`;
    const spy = queueSpy();
    const r = await request(
      url,
      { method: 'POST', headers: signed ? await plivoHeaders(url, body) : {}, body },
      spy.over,
    );
    return { r, xml: await r.text(), sent: spy.sent };
  }

  const hex = () => crypto.randomUUID().replace(/-/g, '');

  it('dials the stored destination from the stored caller id, and stores the start event', async () => {
    const { orgId } = await plivoOwner('conn-ans-ok', N(85));
    const state = hex();
    await authorizedCall(orgId, state, '+12025550123');
    const { r, xml, sent } = await answer(orgId, answerBody(state, '+12025550123'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/xml');
    expect(xml).toContain(
      `<Dial callerId="${N(81)}" callbackUrl="${API_HOST}/webhooks/plivo/${orgId}" callbackMethod="POST"><Number>+12025550123</Number></Dial>`,
    );
    expect(sent).toHaveLength(1);
  });

  it('hangs up a call KNOQRA did not authorize, a changed destination, or an ended call', async () => {
    const { orgId } = await plivoOwner('conn-ans-no', N(86));
    const other = await plivoOwner('conn-ans-other', N(87));
    const mine = hex();
    await authorizedCall(orgId, mine, '+12025550123');
    const ended = hex();
    await authorizedCall(orgId, ended, '+12025550123', 'completed');
    const foreign = hex();
    await authorizedCall(other.orgId, foreign, '+12025550123');
    for (const body of [
      answerBody(hex(), '+12025550123'),
      answerBody(mine, '+12025550199'),
      answerBody(ended, '+12025550123'),
      answerBody(foreign, '+12025550123'),
      answerBody(null, '+12025550123'),
    ]) {
      const { r, xml } = await answer(orgId, body);
      expect(r.status).toBe(200);
      expect(xml).toContain('<Hangup');
      expect(xml).not.toContain('<Dial');
    }
  });

  it('refuses an unsigned request', async () => {
    const { orgId } = await plivoOwner('conn-ans-unsigned', N(81));
    const { r } = await answer(orgId, answerBody(hex(), '+12025550123'), false);
    expect(r.status).toBe(401);
  });
});

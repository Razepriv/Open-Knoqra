import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  channelConnection,
  channelRoute,
  contact,
  contactPermissionEvent,
  conversation,
  message,
  messageStatusEvent,
  providerCredential,
  providerEventRaw,
  withTenant,
} from '@knoqra/db';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { logger } from '../src/lib/logger';
import { composerFor } from '../src/messaging/composer';
import { sendMessage } from '../src/messaging/send';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { handleProviderEvents } from '../src/queue/consumer';
import { adapterFor, ingestWebhook } from '../src/routes/webhooks';
import { credit, ensureWallet } from '../src/services/ledger';
import {
  api,
  get,
  phoneNumbersFetch,
  post,
  saveTelnyxCredential,
  seedSyncedNumber,
  sendersRequest,
  signUp,
  TEST_TELNYX_API_KEY,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

/*
 * Live Telnyx messaging end to end: signed Telnyx message webhooks through ingest, the queue, the
 * event registry and the message handler; the credential-and-flag live gate; and sends through the
 * real TelnyxMessagingProvider with an injected fetch (no network).
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Channel = 'sms' | 'whatsapp';

interface Org {
  cookie: string;
  orgId: string;
  userId: string;
}

/** Sender addresses used only by this file; their telnyx routes are cleared before the run. */
const SENDER_NUMBERS = [150, 151, 152, 153, 154, 155, 156, 157, 158, 159].map(
  (n) => `+12025550${n}`,
);
let senderSeq = 0;
const nextSenderNumber = () => {
  const n = SENDER_NUMBERS[senderSeq];
  senderSeq += 1;
  if (!n) throw new Error('out of sender test numbers');
  return n;
};

/** Contact numbers are unique per org, so a per-org counter is enough. */
const phoneSeq = new Map<string, number>();
const nextPhone = (org: Org) => {
  const n = (phoneSeq.get(org.orgId) ?? 99) + 1;
  if (n > 149) throw new Error('out of 555-01xx contact test numbers');
  phoneSeq.set(org.orgId, n);
  return `+1202555${String(n).padStart(4, '0')}`;
};

// --- Ed25519 signing, as M2's webhook tests do -------------------------------------------------

type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
  'sign',
  'verify',
])) as KeyPair;
const publicKeyBase64 = toBase64(
  new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer),
);

async function signTelnyx(body: Uint8Array): Promise<Headers> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const prefix = new TextEncoder().encode(`${timestamp}|`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, signed),
  );
  return new Headers({
    'telnyx-signature-ed25519': toBase64(signature),
    'telnyx-timestamp': timestamp,
  });
}

// --- environments -------------------------------------------------------------------------------

const baseEnv = env as unknown as Env;
/** Telnyx selected, both channel flags on: only the credential and registration still gate. */
const liveEnv = {
  ...baseEnv,
  PROVIDER: 'telnyx',
  TELNYX_PUBLIC_KEY: publicKeyBase64,
  SMS_10DLC_APPROVED: 'true',
  WHATSAPP_META_APPROVED: 'true',
} as Env;

function queueSpy(base: Env) {
  const sent: string[] = [];
  const queue = { send: async (m: { rawEventId: string }) => void sent.push(m.rawEventId) };
  return { sent, env: { ...base, PROVIDER_EVENTS: queue } as unknown as Env };
}

// --- Telnyx webhook bodies (shaped like the provider fixtures) ----------------------------------

interface TelnyxBody {
  eventType: 'message.received' | 'message.sent' | 'message.finalized' | 'message.read';
  messageId: string;
  type: 'SMS' | 'WHATSAPP';
  from: string;
  to: string;
  status?: string;
  text?: string;
  eventId?: string;
}

function telnyxBody(spec: TelnyxBody): string {
  const inbound = spec.eventType === 'message.received';
  return JSON.stringify({
    data: {
      record_type: 'event',
      id: spec.eventId ?? crypto.randomUUID(),
      event_type: spec.eventType,
      occurred_at: new Date().toISOString(),
      payload: {
        record_type: 'message',
        direction: inbound ? 'inbound' : 'outbound',
        id: spec.messageId,
        type: spec.type,
        from: { phone_number: spec.from },
        to: [{ phone_number: spec.to, ...(spec.status ? { status: spec.status } : {}) }],
        ...(spec.type === 'WHATSAPP' && inbound
          ? { body: { type: 'text', text: { body: spec.text ?? '' } } }
          : { text: spec.text ?? null }),
        errors: [],
      },
    },
    meta: { attempt: 1, delivered_to: 'https://hooks.example.test/webhooks/telnyx' },
  });
}

/** Signs, ingests through `/webhooks/telnyx`'s adapter and runs the queue consumer. */
async function deliverTelnyx(body: string) {
  const adapter = adapterFor('telnyx', liveEnv);
  if (!adapter) throw new Error('telnyx adapter unavailable');
  const bytes = new TextEncoder().encode(body);
  const spy = queueSpy(liveEnv);
  const result = await ingestWebhook(spy.env, adapter, await signTelnyx(bytes), bytes);
  expect(result.status).toBe(200);
  const rawEventId = spy.sent[0];
  if (!rawEventId) throw new Error('not queued');
  const msg = { body: { rawEventId }, ack: vi.fn(), retry: vi.fn() };
  const batch = { messages: [msg] } as unknown as MessageBatch<{ rawEventId: string }>;
  await handleProviderEvents(batch, liveEnv);
  expect(msg.ack).toHaveBeenCalledTimes(1);
  return rawEventId;
}

// --- org setup ----------------------------------------------------------------------------------

function put(path: string, cookie: string, body: unknown) {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!me.data) throw new Error('no active organization');
  const org = { cookie, orgId: me.data.organization.id, userId: me.data.user.id };
  await fundWallet(org);
  return org;
}

/**
 * Credit on M2's wallet. A Telnyx sender gets no development starter credit, so once sends are
 * charged a live send needs a funded wallet; before that this credit is simply unused.
 */
function fundWallet(org: Org) {
  return tenant(org, async (tx) => {
    await ensureWallet(tx, org.orgId, { starterCredit: false });
    await credit(tx, {
      orgId: org.orgId,
      amountMicros: 10_000_000,
      note: 'Test: live messaging credit',
      idempotencyKey: 'test-telnyx-messaging-credit',
      actorUserId: null,
    });
  });
}

const tenant = <T>(org: Org, fn: Parameters<typeof withTenant<T>>[2]) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

/**
 * A telnyx sender through the owner-only route, on a Telnyx deployment: M4's sync lists the number
 * as active and registered (10DLC and Meta), and Telnyx confirms the org owns it. Returns its
 * address.
 */
async function telnyxSender(org: Org, channel: Channel): Promise<string> {
  const address = nextSenderNumber();
  await seedSyncedNumber(org.orgId, address);
  const r = await sendersRequest(
    phoneNumbersFetch([address]).impl,
    liveEnv,
    `/api/v1/messaging/senders/${channel}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: org.cookie },
      // WhatsApp's status is the owner's until M4's sync reads Meta (ruling AR).
      body: JSON.stringify(
        channel === 'whatsapp' ? { address, registrationStatus: 'approved' } : { address },
      ),
    },
  );
  expect(r.status).toBe(200);
  return address;
}

/** A consented contact and its conversation on `channel`. */
async function thread(org: Org, channel: Channel = 'sms') {
  const phone = nextPhone(org);
  const created = await post('/api/v1/contacts', org.cookie, { displayName: 'Sam Rivera', phone });
  expect(created.status).toBe(201);
  const contactId = ((await created.json()) as Envelope<{ id: string }>).data?.id as string;
  const granted = await put(`/api/v1/contacts/${contactId}/permissions/${channel}`, org.cookie, {
    status: 'granted',
    evidence: 'Agreed in person',
  });
  expect(granted.status).toBe(200);
  const conv = await post('/api/v1/conversations', org.cookie, { contactId, channel });
  expect(conv.status).toBe(201);
  const conversationId = ((await conv.json()) as Envelope<{ id: string }>).data?.id as string;
  return { contactId, conversationId, phone };
}

async function composerOf(org: Org, conversationId: string, envFor: Env) {
  return tenant(org, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    if (!conv) throw new Error('conversation missing');
    return (await composerFor(tx, envFor, [conv], new Date())).get(conversationId);
  });
}

/** An injected fetch answering every Telnyx request with `status` and `body`. */
function telnyxFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const accepted = (id: string) => ({
  data: { record_type: 'message', id, type: 'SMS', to: [{ status: 'queued' }], errors: [] },
});

beforeAll(async () => {
  await withAdminDb((db) =>
    db
      .delete(channelRoute)
      .where(
        and(eq(channelRoute.provider, 'telnyx'), inArray(channelRoute.address, SENDER_NUMBERS)),
      ),
  );
});

describe('signed Telnyx message webhooks', () => {
  let org: Org;
  let sms: string;
  let whatsapp: string;

  beforeAll(async () => {
    org = await newOrg('tx-hooks');
    await saveTelnyxCredential(org.orgId, null);
    sms = await telnyxSender(org, 'sms');
    whatsapp = await telnyxSender(org, 'whatsapp');
  });

  it('creates a thread for an inbound SMS', async () => {
    const from = nextPhone(org);
    const messageId = crypto.randomUUID();
    await deliverTelnyx(
      telnyxBody({
        eventType: 'message.received',
        messageId,
        type: 'SMS',
        from,
        to: sms,
        text: 'Hi, is this the shop?',
      }),
    );
    const [row] = await tenant(org, (tx) =>
      tx.select().from(message).where(eq(message.providerMessageId, messageId)),
    );
    expect(row).toMatchObject({
      direction: 'inbound',
      provider: 'telnyx',
      status: 'received',
      body: 'Hi, is this the shop?',
      channel: 'sms',
    });
    const [c] = await tenant(org, (tx) =>
      tx.select().from(contact).where(eq(contact.phoneE164, from)),
    );
    expect(c?.source).toBe('inbound');
  });

  it('follows a finalized delivered receipt to delivered', async () => {
    const t = await thread(org, 'sms');
    const providerId = crypto.randomUUID();
    const fetcher = telnyxFetch(200, accepted(providerId));
    const result = await withAppDb((db) =>
      sendMessage(
        {
          db,
          env: liveEnv,
          tenant: { orgId: org.orgId, userId: org.userId, role: 'owner' },
          fetch: fetcher.impl,
        },
        t.conversationId,
        { clientMessageId: crypto.randomUUID(), body: 'Your order shipped' },
      ),
    );
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.message.providerMessageId).toBe(providerId);

    await deliverTelnyx(
      telnyxBody({
        eventType: 'message.finalized',
        messageId: providerId,
        type: 'SMS',
        from: sms,
        to: t.phone,
        status: 'delivered',
      }),
    );
    const [row] = await tenant(org, (tx) =>
      tx.select().from(message).where(eq(message.id, result.message.id)),
    );
    expect(row?.status).toBe('delivered');
  });

  it('marks a WhatsApp message read on message.read', async () => {
    const phone = nextPhone(org);
    const providerId = crypto.randomUUID();
    const messageId = await tenant(org, async (tx) => {
      const [c] = await tx
        .insert(contact)
        .values({ organizationId: org.orgId, displayName: 'Reader', phoneE164: phone })
        .returning();
      if (!c) throw new Error('contact insert failed');
      const conv = await ensureConversation(tx, org.orgId, c.id, 'whatsapp');
      const row = await insertMessage(tx, {
        orgId: org.orgId,
        conversation: conv,
        direction: 'outbound',
        body: 'Your table is ready',
        status: 'sent',
        provider: 'telnyx',
        providerMessageId: providerId,
        occurredAt: new Date(),
      });
      return row.id;
    });
    await deliverTelnyx(
      telnyxBody({
        eventType: 'message.read',
        messageId: providerId,
        type: 'WHATSAPP',
        from: whatsapp,
        to: phone,
        status: 'read',
      }),
    );
    const [row] = await tenant(org, (tx) =>
      tx.select().from(message).where(eq(message.id, messageId)),
    );
    expect(row?.status).toBe('read');
  });

  it('opts the contact out of SMS on a STOP reply', async () => {
    const from = nextPhone(org);
    await deliverTelnyx(
      telnyxBody({
        eventType: 'message.received',
        messageId: crypto.randomUUID(),
        type: 'SMS',
        from,
        to: sms,
        text: 'STOP',
      }),
    );
    const events = await tenant(org, async (tx) => {
      const [c] = await tx.select().from(contact).where(eq(contact.phoneE164, from));
      if (!c) throw new Error('contact missing');
      return tx
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, c.id));
    });
    expect(events.map((e) => [e.channel, e.status, e.source])).toEqual([
      ['sms', 'opted_out', 'inbound_stop'],
    ]);
  });

  it('answers 401 for a bad signature and stores nothing', async () => {
    const adapter = adapterFor('telnyx', liveEnv);
    if (!adapter) throw new Error('telnyx adapter unavailable');
    const eventId = crypto.randomUUID();
    const body = telnyxBody({
      eventType: 'message.received',
      messageId: crypto.randomUUID(),
      type: 'SMS',
      from: nextPhone(org),
      to: sms,
      text: 'forged',
      eventId,
    });
    const bytes = new TextEncoder().encode(body);
    const headers = await signTelnyx(bytes);
    const tampered = new TextEncoder().encode(body.replace('forged', 'Forged'));
    const spy = queueSpy(liveEnv);
    const result = await ingestWebhook(spy.env, adapter, headers, tampered);
    expect(result).toEqual({ status: 401, error: 'invalid_signature' });
    expect(spy.sent).toEqual([]);
    const rows = await withAdminDb((db) =>
      db
        .select()
        .from(providerEventRaw)
        .where(
          and(
            eq(providerEventRaw.provider, 'telnyx'),
            eq(providerEventRaw.externalEventId, eventId),
          ),
        ),
    );
    expect(rows).toEqual([]);
  });

  /** An outbound SMS sent through Telnyx (injected fetch); returns its ids and the contact. */
  async function sentSms() {
    const t = await thread(org, 'sms');
    const providerId = crypto.randomUUID();
    const result = await withAppDb((db) =>
      sendMessage(
        {
          db,
          env: liveEnv,
          tenant: { orgId: org.orgId, userId: org.userId, role: 'owner' },
          fetch: telnyxFetch(200, accepted(providerId)).impl,
        },
        t.conversationId,
        { clientMessageId: crypto.randomUUID(), body: 'Your order shipped' },
      ),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    return { t, providerId, messageId: result.message.id };
  }

  const statusEvents = (messageId: string) =>
    tenant(org, (tx) =>
      tx.select().from(messageStatusEvent).where(eq(messageStatusEvent.messageId, messageId)),
    );
  const statusOf = async (messageId: string) =>
    (await tenant(org, (tx) => tx.select().from(message).where(eq(message.id, messageId))))[0]
      ?.status;

  it('takes the same signed receipt delivered twice once', async () => {
    const { t, providerId, messageId } = await sentSms();
    const body = telnyxBody({
      eventType: 'message.finalized',
      messageId: providerId,
      type: 'SMS',
      from: sms,
      to: t.phone,
      status: 'delivered',
    });
    await deliverTelnyx(body);

    const adapter = adapterFor('telnyx', liveEnv);
    if (!adapter) throw new Error('telnyx adapter unavailable');
    const bytes = new TextEncoder().encode(body);
    const spy = queueSpy(liveEnv);
    const again = await ingestWebhook(spy.env, adapter, await signTelnyx(bytes), bytes);
    expect(again).toEqual({ status: 200, duplicate: true });
    expect(spy.sent).toEqual([]);

    expect(await statusOf(messageId)).toBe('delivered');
    const delivered = (await statusEvents(messageId)).filter((e) => e.status === 'delivered');
    expect(delivered).toHaveLength(1);
  });

  it('keeps delivered when a late message.sent arrives after the final receipt', async () => {
    const { t, providerId, messageId } = await sentSms();
    const receipt = (eventType: 'message.finalized' | 'message.sent', status: string) =>
      telnyxBody({
        eventType,
        messageId: providerId,
        type: 'SMS',
        from: sms,
        to: t.phone,
        status,
      });
    await deliverTelnyx(receipt('message.finalized', 'delivered'));
    await deliverTelnyx(receipt('message.sent', 'sent'));
    expect(await statusOf(messageId)).toBe('delivered');
  });

  it('wires POST /webhooks/telnyx: verify, store and queue at the edge', async () => {
    const from = nextPhone(org);
    const messageId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const body = telnyxBody({
      eventType: 'message.received',
      messageId,
      type: 'SMS',
      from,
      to: sms,
      text: 'Through the front door',
      eventId,
    });
    const bytes = new TextEncoder().encode(body);
    const spy = queueSpy(liveEnv);
    const post = async (headers: Headers, payload: Uint8Array) => {
      const ctx = createExecutionContext();
      headers.set('content-type', 'application/json');
      const r = await app.request(
        '/webhooks/telnyx',
        { method: 'POST', headers, body: payload },
        spy.env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return r;
    };

    const forged = await post(
      await signTelnyx(bytes),
      new TextEncoder().encode(body.replace('front', 'back')),
    );
    expect(forged.status).toBe(401);
    expect(spy.sent).toEqual([]);

    const r = await post(await signTelnyx(bytes), bytes);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Envelope<unknown>).data).toEqual({
      received: true,
      duplicate: false,
    });
    expect(spy.sent).toHaveLength(1);
    const [raw] = await withAdminDb((db) =>
      db
        .select()
        .from(providerEventRaw)
        .where(
          and(
            eq(providerEventRaw.provider, 'telnyx'),
            eq(providerEventRaw.externalEventId, eventId),
          ),
        ),
    );
    expect(raw?.id).toBe(spy.sent[0]);

    const msg = { body: { rawEventId: spy.sent[0] }, ack: vi.fn(), retry: vi.fn() };
    const batch = { messages: [msg] } as unknown as MessageBatch<{ rawEventId: string }>;
    await handleProviderEvents(batch, liveEnv);
    expect(msg.ack).toHaveBeenCalledTimes(1);
    const [row] = await tenant(org, (tx) =>
      tx.select().from(message).where(eq(message.providerMessageId, messageId)),
    );
    expect(row).toMatchObject({ direction: 'inbound', body: 'Through the front door' });
  });
});

describe('live gate', () => {
  async function gatedOrg(label: string, opts: { credential: boolean; status?: string }) {
    const org = await newOrg(label);
    // The connection is written directly: the senders route itself requires a credential.
    await tenant(org, (tx) =>
      tx.insert(channelConnection).values({
        organizationId: org.orgId,
        channel: 'sms',
        provider: 'telnyx',
        address: '+12025550199',
        registrationStatus: (opts.status ?? 'approved') as 'approved',
      }),
    );
    if (opts.credential) await saveTelnyxCredential(org.orgId, null);
    const t = await thread(org, 'sms');
    return { org, t };
  }

  it('pauses with live_disabled without a saved credential', async () => {
    const { org, t } = await gatedOrg('gate-nocred', { credential: false });
    expect(await composerOf(org, t.conversationId, liveEnv)).toMatchObject({
      mode: 'paused',
      reason: 'live_disabled',
    });
  });

  it('pauses with live_disabled when the channel flag is unset', async () => {
    const { org, t } = await gatedOrg('gate-noflag', { credential: true });
    const noFlag = { ...liveEnv, SMS_10DLC_APPROVED: undefined } as Env;
    expect(await composerOf(org, t.conversationId, noFlag)).toMatchObject({
      mode: 'paused',
      reason: 'live_disabled',
    });
    const notTrue = { ...liveEnv, SMS_10DLC_APPROVED: 'yes' } as Env;
    expect((await composerOf(org, t.conversationId, notTrue))?.reason).toBe('live_disabled');
  });

  it('is free with a credential, the flag and an approved registration', async () => {
    const { org, t } = await gatedOrg('gate-free', { credential: true });
    expect(await composerOf(org, t.conversationId, liveEnv)).toMatchObject({ mode: 'free' });
  });

  it('pauses with registration_pending while the registration is pending', async () => {
    const { org, t } = await gatedOrg('gate-pending', { credential: true, status: 'pending' });
    expect(await composerOf(org, t.conversationId, liveEnv)).toMatchObject({
      mode: 'paused',
      reason: 'registration_pending',
    });
  });

  it('keeps telnyx not live while PROVIDER is fake', async () => {
    const { org, t } = await gatedOrg('gate-fake', { credential: true });
    const fakeProvider = { ...liveEnv, PROVIDER: 'fake' } as Env;
    expect(await composerOf(org, t.conversationId, fakeProvider)).toMatchObject({
      mode: 'paused',
      reason: 'live_disabled',
    });
    const senders = await tenant(org, async (tx) => {
      const { listSenders } = await import('../src/messaging/senders');
      return listSenders(tx, fakeProvider);
    });
    expect(senders.map((s) => s.liveEnabled)).toEqual([false]);
  });
});

describe('sending through Telnyx', () => {
  let org: Org;

  beforeAll(async () => {
    org = await newOrg('tx-send');
    await saveTelnyxCredential(org.orgId, null);
    await telnyxSender(org, 'sms');
  });

  const deps = (fetchImpl: typeof fetch) => (db: Parameters<typeof sendMessage>[0]['db']) => ({
    db,
    env: liveEnv,
    tenant: { orgId: org.orgId, userId: org.userId, role: 'owner' },
    fetch: fetchImpl,
  });

  it('sends with the vault key and records the provider message id', async () => {
    const t = await thread(org, 'sms');
    const providerId = crypto.randomUUID();
    const fetcher = telnyxFetch(200, accepted(providerId));
    const result = await withAppDb((db) =>
      sendMessage(deps(fetcher.impl)(db), t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'See you at 3',
      }),
    );
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.message).toMatchObject({ status: 'queued', providerMessageId: providerId });
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.url).toBe('https://api.telnyx.com/v2/messages');
    const headers = new Headers(fetcher.calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TEST_TELNYX_API_KEY}`);
  });

  it('records an opt-out when Telnyx answers 40300', async () => {
    const t = await thread(org, 'sms');
    const fetcher = telnyxFetch(403, {
      errors: [{ code: '40300', title: 'Blocked (STOP)' }],
    });
    const result = await withAppDb((db) =>
      sendMessage(deps(fetcher.impl)(db), t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Hello again',
      }),
    );
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.message.status).toBe('failed');
    const events = await tenant(org, (tx) =>
      tx
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, t.contactId)),
    );
    expect(events.map((e) => e.status)).toContain('opted_out');
  });

  it('fails the message with provider_auth on a Telnyx 401, never logging the key', async () => {
    const t = await thread(org, 'sms');
    // The body echoes the key and the number, to prove neither reaches a log line.
    const fetcher = telnyxFetch(401, {
      errors: [
        {
          code: '10009',
          title: 'Authentication failed',
          detail: `Key ${TEST_TELNYX_API_KEY} was rejected for ${t.phone}`,
        },
      ],
    });
    const captured: unknown[] = [];
    const capture =
      (level: string) =>
      (...args: unknown[]) =>
        void captured.push([level, ...args]);
    const spies = [
      vi.spyOn(logger, 'debug').mockImplementation(capture('debug')),
      vi.spyOn(logger, 'info').mockImplementation(capture('info')),
      vi.spyOn(logger, 'warn').mockImplementation(capture('warn')),
      vi.spyOn(logger, 'error').mockImplementation(capture('error')),
      vi.spyOn(console, 'log').mockImplementation(capture('console.log')),
      vi.spyOn(console, 'error').mockImplementation(capture('console.error')),
    ];
    let result: Awaited<ReturnType<typeof sendMessage>>;
    try {
      result = await withAppDb((db) =>
        sendMessage(deps(fetcher.impl)(db), t.conversationId, {
          clientMessageId: crypto.randomUUID(),
          body: 'Hello there',
        }),
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // A created (201) failed message, not a thrown 500.
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') return;
    expect(result.message.status).toBe('failed');
    expect(result.message.error?.code).toBe('provider_auth');
    expect(fetcher.calls).toHaveLength(1);
    const logged = JSON.stringify(captured);
    expect(logged).toContain('messaging.provider_send_failed');
    expect(logged).not.toContain(TEST_TELNYX_API_KEY);
    expect(logged).not.toContain(t.phone);
  });

  it('pauses without calling Telnyx once the credential is removed', async () => {
    const t = await thread(org, 'sms');
    await tenant(org, (tx) =>
      tx.delete(providerCredential).where(eq(providerCredential.provider, 'telnyx')),
    );
    const fetcher = telnyxFetch(200, accepted(crypto.randomUUID()));
    const result = await withAppDb((db) =>
      sendMessage(deps(fetcher.impl)(db), t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Anyone there?',
      }),
    );
    expect(result).toMatchObject({ kind: 'error', status: 422, code: 'send_paused' });
    expect(fetcher.calls).toEqual([]);
  });
});

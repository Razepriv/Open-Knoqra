import { env } from 'cloudflare:workers';
import { MESSAGE_RATE_MICROS } from '@knoqra/core';
import { auditEvent, ledgerEntry, message, wallet, withTenant } from '@knoqra/db';
import {
  FakeProvider,
  fakeMessageEvent,
  type MessagingProvider,
  type ProviderEventType,
  toFakeWebhookBody,
} from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { ledgerMessageCost, type MessageCostHook } from '../src/messaging/cost';
import { sendMessage } from '../src/messaging/send';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { handleProviderEvents } from '../src/queue/consumer';
import { ingestWebhook } from '../src/routes/webhooks';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';
import { eventually } from './messaging-helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Msg = { id: string; status: string; providerMessageId: string | null };

interface Org {
  cookie: string;
  orgId: string;
  userId: string;
  smsAddress: string;
}

interface Thread {
  contactId: string;
  conversationId: string;
  phone: string;
}

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });
const SMS_RATE = MESSAGE_RATE_MICROS.sms;

/** Reserved 555-01xx numbers; the counter is per org, as phone uniqueness is per org. */
const phoneSeq = new Map<string, number>();
const nextPhone = (org: Org) => {
  const n = (phoneSeq.get(org.orgId) ?? 99) + 1;
  if (n > 199) throw new Error('out of 555-01xx test numbers');
  phoneSeq.set(org.orgId, n);
  return `+1202555${String(n).padStart(4, '0')}`;
};

function put(path: string, cookie: string, body: unknown) {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function setupOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!me.data) throw new Error('no active organization');
  const sandbox = await put('/api/v1/messaging/sandbox', cookie, {
    sms: 'approved',
    whatsapp: 'approved',
  });
  expect(sandbox.status).toBe(200);
  const senders = (await (await get('/api/v1/messaging/senders', cookie)).json()) as Envelope<{
    items: Array<{ channel: string; address: string }>;
  }>;
  return {
    cookie,
    orgId: me.data.organization.id,
    userId: me.data.user.id,
    smsAddress: senders.data?.items.find((s) => s.channel === 'sms')?.address as string,
  };
}

/** A consented SMS contact and its conversation. */
async function thread(org: Org): Promise<Thread> {
  const phone = nextPhone(org);
  const created = await post('/api/v1/contacts', org.cookie, { displayName: 'Sam Rivera', phone });
  expect(created.status).toBe(201);
  const contactId = ((await created.json()) as Envelope<{ id: string }>).data?.id as string;
  const granted = await put(`/api/v1/contacts/${contactId}/permissions/sms`, org.cookie, {
    status: 'granted',
    evidence: 'Agreed in person',
  });
  expect(granted.status).toBe(200);
  const conv = await post('/api/v1/conversations', org.cookie, { contactId, channel: 'sms' });
  expect(conv.status).toBe(201);
  const conversationId = ((await conv.json()) as Envelope<{ id: string }>).data?.id as string;
  return { contactId, conversationId, phone };
}

async function sendText(org: Org, conversationId: string, text = 'Your table is ready') {
  const r = await post(`/api/v1/conversations/${conversationId}/messages`, org.cookie, {
    clientMessageId: crypto.randomUUID(),
    body: text,
  });
  return { status: r.status, body: (await r.json()) as Envelope<Msg> };
}

/**
 * Sends over HTTP and waits for the provider's answer: the route answers once the message is
 * stored, and the provider send (and its id) lands after the response.
 */
async function sentMessage(org: Org, t: Thread): Promise<Msg> {
  const r = await sendText(org, t.conversationId);
  expect(r.status).toBe(201);
  const queued = r.body.data as Msg;
  return eventually(
    async () =>
      ((await (await get(`/api/v1/messages/${queued.id}`, org.cookie)).json()) as Envelope<Msg>)
        .data as Msg,
    (m) => m.providerMessageId !== null,
  );
}

const tenantOf = (org: Org) => ({ orgId: org.orgId, userId: org.userId, role: 'owner' });

const entriesFor = (org: Org, messageId: string) =>
  withAppDb((db) =>
    withTenant(db, org.orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntry)
        .where(and(eq(ledgerEntry.refType, 'message'), eq(ledgerEntry.refId, messageId))),
    ),
  );

const kindsFor = async (org: Org, messageId: string) =>
  (await entriesFor(org, messageId)).map((e) => e.kind).sort();

const rowsByConversation = (org: Org, conversationId: string) =>
  withAppDb((db) =>
    withTenant(db, org.orgId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    ),
  );

/** Stores one fake receipt through the webhook path; answers its raw event id. */
async function storeReceipt(
  org: Org,
  type: ProviderEventType,
  providerMessageId: string,
  to: string,
  opts: { final?: boolean; eventId?: string } = {},
) {
  const body = toFakeWebhookBody(
    fakeMessageEvent({
      type,
      providerMessageId,
      payload: {
        channel: 'sms',
        from: org.smsAddress,
        to,
        ...(opts.final === undefined ? {} : { final: opts.final }),
      },
      ...(opts.eventId === undefined ? {} : { eventId: opts.eventId }),
    }),
  );
  const queued: string[] = [];
  const spyEnv = {
    ...env,
    PROVIDER_EVENTS: { send: async (m: { rawEventId: string }) => void queued.push(m.rawEventId) },
  } as unknown as Env;
  const headers = new Headers({ 'x-fake-signature': await fake.signWebhook(body) });
  const bytes = new TextEncoder().encode(body);
  expect((await ingestWebhook(spyEnv, fake, headers, bytes)).status).toBe(200);
  return queued[0] as string;
}

/** Runs the queue consumer over one stored raw event (again, for a replay). */
async function processEvent(rawEventId: string) {
  const msg = { body: { rawEventId }, ack: vi.fn(), retry: vi.fn() };
  const batch = { messages: [msg] } as unknown as MessageBatch<{ rawEventId: string }>;
  await handleProviderEvents(batch, env);
  expect(msg.ack).toHaveBeenCalledTimes(1);
}

async function receipt(org: Org, type: ProviderEventType, m: Msg, t: Thread) {
  await processEvent(await storeReceipt(org, type, m.providerMessageId as string, t.phone));
}

/** Opens the wallet (with the starter credit), then spends all of it. */
async function emptyWallet(org: Org) {
  expect((await get('/api/v1/wallet', org.cookie)).status).toBe(200);
  await withAdminDb(async (db) => {
    const [w] = await db.select().from(wallet).where(eq(wallet.organizationId, org.orgId));
    if (!w) throw new Error('wallet missing');
    const entries = await db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.organizationId, org.orgId));
    const balance = entries.reduce((sum, e) => sum + e.balanceDeltaMicros, 0);
    await db.insert(ledgerEntry).values({
      organizationId: org.orgId,
      walletId: w.id,
      kind: 'adjust',
      balanceDeltaMicros: -balance,
      heldDeltaMicros: 0,
      idempotencyKey: `test-empty-${crypto.randomUUID()}`,
      note: 'Test: spend the starter credit',
    });
  });
}

const deniedReasons = async (org: Org) =>
  (
    await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, org.orgId),
            eq(auditEvent.action, 'message.send'),
            eq(auditEvent.outcome, 'denied'),
          ),
        ),
    )
  ).map((a) => (a.metadata as { reason?: string }).reason);

function countingProvider() {
  const calls: Array<{ idempotencyKey: string }> = [];
  const inner = new FakeProvider({
    webhookSecret: 'unused',
    messageIdFactory: () => `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  const provider: MessagingProvider = {
    async sendSms(input) {
      calls.push(input);
      return inner.sendSms(input);
    },
    async sendWhatsApp(input) {
      calls.push(input);
      return inner.sendWhatsApp(input);
    },
  };
  return { provider, calls };
}

const throwingProvider: MessagingProvider = {
  async sendSms() {
    throw new Error('upstream 500');
  },
  async sendWhatsApp() {
    throw new Error('upstream 500');
  },
};

let org: Org;

beforeAll(async () => {
  org = await setupOrg('msg-cost');
});

describe('reserve on send', () => {
  it('holds the SMS rate, keyed by the message, with the sender as actor', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    const entries = await entriesFor(org, m.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'reserve',
      heldDeltaMicros: SMS_RATE,
      balanceDeltaMicros: 0,
      idempotencyKey: `message:${m.id}:reserve`,
      refType: 'message',
      refId: m.id,
      actorUserId: org.userId,
    });
  });

  it('refuses an empty wallet with 402, no message, no provider call and a denied audit', async () => {
    const broke = await setupOrg('msg-cost-empty');
    const t = await thread(broke);
    await emptyWallet(broke);
    const r = await sendText(broke, t.conversationId);
    expect(r.status).toBe(402);
    expect(r.body.error).toEqual({
      code: 'spend_blocked',
      message: 'Not enough credit for this message.',
    });
    expect(await rowsByConversation(broke, t.conversationId)).toHaveLength(0);
    expect(await deniedReasons(broke)).toContain('insufficient_funds');

    const { provider, calls } = countingProvider();
    const direct = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(broke), provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Again',
      }),
    );
    expect(direct).toMatchObject({ kind: 'error', status: 402, code: 'spend_blocked' });
    expect(calls).toHaveLength(0);
    const reserves = await withAppDb((db) =>
      withTenant(db, broke.orgId, (tx) =>
        tx.select().from(ledgerEntry).where(eq(ledgerEntry.kind, 'reserve')),
      ),
    );
    expect(reserves).toHaveLength(0);
    // Sets up a whole org inside the test body: give it the hook budget, not the default.
  }, 60_000);

  it('refuses a send past the stop cap with the cap copy', async () => {
    const capped = await setupOrg('msg-cost-cap');
    const t = await thread(capped);
    expect((await get('/api/v1/wallet', capped.cookie)).status).toBe(200);
    await withAdminDb((db) =>
      db.update(wallet).set({ stopCapMicros: 1 }).where(eq(wallet.organizationId, capped.orgId)),
    );
    const r = await sendText(capped, t.conversationId);
    expect(r.status).toBe(402);
    expect(r.body.error).toEqual({
      code: 'spend_blocked',
      message: 'This message would pass the monthly spend cap.',
    });
    expect(await rowsByConversation(capped, t.conversationId)).toHaveLength(0);
    expect(await deniedReasons(capped)).toContain('stop_cap');
    // Sets up a whole org inside the test body: give it the hook budget, not the default.
  }, 60_000);

  it('retries the send transaction once after a deadlock, holding the rate once', async () => {
    const t = await thread(org);
    const ledger = ledgerMessageCost(env);
    let attempts = 0;
    // Reserves, then fails as Postgres would for the loser of a deadlock: the hold rolls back.
    const cost: MessageCostHook = {
      async beforeSend(tx, input) {
        attempts += 1;
        const result = await ledger.beforeSend(tx, input);
        if (attempts === 1) {
          throw new Error('query failed', {
            cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
          });
        }
        return result;
      },
    };
    const { provider, calls } = countingProvider();
    const result = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(org), cost, provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'After a deadlock',
      }),
    );
    expect(result.kind).toBe('created');
    expect(attempts).toBe(2);
    expect(calls).toHaveLength(1);
    const sent = result.kind === 'created' ? result.message.id : '';
    expect(await kindsFor(org, sent)).toEqual(['reserve']);
    expect(await rowsByConversation(org, t.conversationId)).toHaveLength(1);
  });
});

describe('capture on delivery', () => {
  it('captures the rate exactly once, even for a duplicate delivered receipt', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.sent', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['reserve']);
    await receipt(org, 'message.delivered', m, t);
    await receipt(org, 'message.delivered', m, t);
    const entries = await entriesFor(org, m.id);
    const captures = entries.filter((e) => e.kind === 'capture');
    const hold = entries.find((e) => e.kind === 'reserve');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      balanceDeltaMicros: -SMS_RATE,
      heldDeltaMicros: -SMS_RATE,
      reservationId: hold?.id,
      idempotencyKey: `message:${m.id}:capture`,
    });
  });

  it('posts nothing new when the same receipt event is processed again', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    const rawEventId = await storeReceipt(
      org,
      'message.delivered',
      m.providerMessageId as string,
      t.phone,
    );
    await processEvent(rawEventId);
    const before = await entriesFor(org, m.id);
    await processEvent(rawEventId);
    const after = await entriesFor(org, m.id);
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    expect(after.map((e) => e.kind).sort()).toEqual(['capture', 'reserve']);
  });

  it('settles once when read follows delivered', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.delivered', m, t);
    await receipt(org, 'message.read', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['capture', 'reserve']);
  });

  it('captures on read alone and ignores a late delivered', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.read', m, t);
    await receipt(org, 'message.delivered', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['capture', 'reserve']);
  });

  it('never releases after a capture when a failure arrives late', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.delivered', m, t);
    await receipt(org, 'message.failed', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['capture', 'reserve']);
  });

  it('changes nothing for a message sent before message costs (no hold)', async () => {
    const t = await thread(org);
    const providerMessageId = `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const legacy = await withAppDb((db) =>
      withTenant(db, org.orgId, async (tx) => {
        const conv = await ensureConversation(tx, org.orgId, t.contactId, 'sms');
        return insertMessage(tx, {
          orgId: org.orgId,
          conversation: conv,
          direction: 'outbound',
          body: 'Before costs',
          status: 'queued',
          provider: 'fake',
          providerMessageId,
          occurredAt: new Date(),
        });
      }),
    );
    const m = { id: legacy.id, status: 'queued', providerMessageId };
    await receipt(org, 'message.delivered', m, t);
    expect(await entriesFor(org, legacy.id)).toHaveLength(0);
    const [row] = await rowsByConversation(org, t.conversationId);
    expect(row?.status).toBe('delivered');
  });
});

describe('capture on a final unconfirmed receipt (ruling AS)', () => {
  /** A final `message.sent` (Telnyx's `delivery_unconfirmed`), with its own event id. */
  const finalSent = (org: Org, m: Msg, t: Thread) =>
    storeReceipt(org, 'message.sent', m.providerMessageId as string, t.phone, {
      final: true,
      eventId: `final_${crypto.randomUUID()}`,
    });

  it('captures once when a final sent follows a sent, through a replay and a late delivered', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.sent', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['reserve']);

    const rawEventId = await finalSent(org, m, t);
    await processEvent(rawEventId);
    const entries = await entriesFor(org, m.id);
    const captures = entries.filter((e) => e.kind === 'capture');
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      balanceDeltaMicros: -SMS_RATE,
      heldDeltaMicros: -SMS_RATE,
      idempotencyKey: `message:${m.id}:capture`,
    });

    // The same event again, then a second final receipt, then a late delivered: nothing new.
    await processEvent(rawEventId);
    await processEvent(await finalSent(org, m, t));
    await receipt(org, 'message.delivered', m, t);
    const after = await entriesFor(org, m.id);
    expect(after.map((e) => e.id).sort()).toEqual(entries.map((e) => e.id).sort());
    const [row] = await rowsByConversation(org, t.conversationId);
    expect(row?.status).toBe('delivered');
  });

  it('captures when the final sent is the first receipt (it moves queued to sent)', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await processEvent(await finalSent(org, m, t));
    expect(await kindsFor(org, m.id)).toEqual(['capture', 'reserve']);
    const [row] = await rowsByConversation(org, t.conversationId);
    expect(row?.status).toBe('sent');
  });

  it('does not capture a non-final sent, nor a final sent after a failure', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.sent', m, t);
    await receipt(org, 'message.sent', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['reserve']);
    await receipt(org, 'message.failed', m, t);
    await processEvent(await finalSent(org, m, t));
    expect(await kindsFor(org, m.id)).toEqual(['release', 'reserve']);
  });
});

describe('release on failure', () => {
  it('releases the hold when a failed receipt arrives, once', async () => {
    const t = await thread(org);
    const m = await sentMessage(org, t);
    await receipt(org, 'message.failed', m, t);
    await receipt(org, 'message.failed', m, t);
    const entries = await entriesFor(org, m.id);
    const releases = entries.filter((e) => e.kind === 'release');
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({
      balanceDeltaMicros: 0,
      heldDeltaMicros: -SMS_RATE,
      idempotencyKey: `message:${m.id}:release`,
    });
    // A late delivery after the release does not capture.
    await receipt(org, 'message.delivered', m, t);
    expect(await kindsFor(org, m.id)).toEqual(['release', 'reserve']);
  });

  it('releases the hold when the provider refuses the send', async () => {
    const t = await thread(org);
    const result = await withAppDb((db) =>
      sendMessage(
        { db, env, tenant: tenantOf(org), provider: throwingProvider },
        t.conversationId,
        {
          clientMessageId: crypto.randomUUID(),
          body: 'Refused upstream',
        },
      ),
    );
    expect(result.kind).toBe('created');
    const sent = result.kind === 'created' ? result.message : null;
    expect(sent?.status).toBe('failed');
    expect(await kindsFor(org, sent?.id as string)).toEqual(['release', 'reserve']);
  });
});

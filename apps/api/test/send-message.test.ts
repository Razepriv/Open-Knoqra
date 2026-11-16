import { env } from 'cloudflare:workers';
import { auditEvent, message, messageTemplate, withTenant } from '@knoqra/db';
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
import type { MessageCostHook } from '../src/messaging/cost';
import { sendMessage } from '../src/messaging/send';
import { messagingProviderFor, type Sender } from '../src/messaging/senders';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { handleProviderEvents } from '../src/queue/consumer';
import { ingestWebhook } from '../src/routes/webhooks';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Msg = {
  id: string;
  conversationId: string;
  channel: string;
  direction: string;
  body: string;
  templateId: string | null;
  templateName: string | null;
  status: string;
  error: { code: string; message: string } | null;
  authorUserId: string | null;
  providerMessageId: string | null;
};
type MsgDetail = Msg & {
  statusHistory: Array<{
    status: string;
    applied: boolean;
    occurredAt: string;
    errorCode: string | null;
  }>;
};
type Conv = {
  id: string;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  lastMessageStatus: string | null;
};

interface Org {
  cookie: string;
  orgId: string;
  userId: string;
  smsAddress: string;
  whatsappAddress: string;
}

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });
const LONG_BODY = 'x'.repeat(1601);

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

async function setupOrg(label: string, sms = 'approved', whatsapp = 'approved'): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!me.data) throw new Error('no active organization');
  const sandbox = await put('/api/v1/messaging/sandbox', cookie, { sms, whatsapp });
  expect(sandbox.status).toBe(200);
  const senders = (await (await get('/api/v1/messaging/senders', cookie)).json()) as Envelope<{
    items: Array<{ channel: string; address: string }>;
  }>;
  const address = (channel: string) =>
    senders.data?.items.find((s) => s.channel === channel)?.address as string;
  return {
    cookie,
    orgId: me.data.organization.id,
    userId: me.data.user.id,
    smsAddress: address('sms'),
    whatsappAddress: address('whatsapp'),
  };
}

interface Thread {
  contactId: string;
  conversationId: string;
  phone: string;
}

/** A contact (through the API), optional consent, and the conversation for the channel. */
async function thread(
  org: Org,
  opts: {
    name?: string;
    /** Names the contact after its own number, as a contact created by an inbound message is. */
    nameIsPhone?: boolean;
    company?: string;
    channel?: 'sms' | 'whatsapp';
    consent?: boolean;
  } = {},
): Promise<Thread> {
  const channel = opts.channel ?? 'sms';
  const phone = nextPhone(org);
  const created = await post('/api/v1/contacts', org.cookie, {
    displayName: opts.nameIsPhone ? phone : (opts.name ?? 'Sam Rivera'),
    phone,
    ...(opts.company === undefined ? {} : { company: opts.company }),
  });
  expect(created.status).toBe(201);
  const contactId = ((await created.json()) as Envelope<{ id: string }>).data?.id as string;
  if (opts.consent !== false) {
    const granted = await put(`/api/v1/contacts/${contactId}/permissions/${channel}`, org.cookie, {
      status: 'granted',
      evidence: 'Agreed in person',
    });
    expect(granted.status).toBe(200);
  }
  const conv = await post('/api/v1/conversations', org.cookie, { contactId, channel });
  expect(conv.status).toBe(201);
  const conversationId = ((await conv.json()) as Envelope<{ id: string }>).data?.id as string;
  return { contactId, conversationId, phone };
}

async function send(org: Org, conversationId: string, body: Record<string, unknown>) {
  const r = await post(`/api/v1/conversations/${conversationId}/messages`, org.cookie, body);
  return { status: r.status, body: (await r.json()) as Envelope<Msg> };
}

const sendText = (org: Org, conversationId: string, text: string) =>
  send(org, conversationId, { clientMessageId: crypto.randomUUID(), body: text });

async function messageDetail(org: Org, id: string) {
  const r = await get(`/api/v1/messages/${id}`, org.cookie);
  return { status: r.status, body: (await r.json()) as Envelope<MsgDetail> };
}

async function createTemplate(org: Org, channel: 'sms' | 'whatsapp', body: string) {
  const r = await post('/api/v1/messaging/templates', org.cookie, {
    name: `Tpl ${crypto.randomUUID().slice(0, 8)}`,
    channel,
    body,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as Envelope<{ id: string; name: string }>).data as {
    id: string;
    name: string;
  };
}

const tenant = <T>(org: Org, fn: Parameters<typeof withTenant<T>>[2]) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

const rowsByClientId = (org: Org, clientMessageId: string) =>
  tenant(org, (tx) =>
    tx.select().from(message).where(eq(message.clientMessageId, clientMessageId)),
  );

const auditsOf = (org: Org, action: string, outcome: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, org.orgId),
          eq(auditEvent.action, action),
          eq(auditEvent.outcome, outcome as 'allowed'),
        ),
      ),
  );

const tenantOf = (org: Org) => ({ orgId: org.orgId, userId: org.userId, role: 'owner' });

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

/** Stores and processes one fake receipt through the webhook and queue path. */
async function receipt(org: Org, type: ProviderEventType, providerMessageId: string, to: string) {
  const body = toFakeWebhookBody(
    fakeMessageEvent({
      type,
      providerMessageId,
      payload: { channel: 'sms', from: org.smsAddress, to },
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
  const rawEventId = queued[0] as string;
  const msg = { body: { rawEventId }, ack: vi.fn(), retry: vi.fn() };
  const batch = { messages: [msg] } as unknown as MessageBatch<{ rawEventId: string }>;
  await handleProviderEvents(batch, env);
  expect(msg.ack).toHaveBeenCalledTimes(1);
}

let orgA: Org;
let orgB: Org;
let pausedOrg: Org;

beforeAll(async () => {
  orgA = await setupOrg('send-a');
  orgB = await setupOrg('send-b');
  pausedOrg = await setupOrg('send-paused', 'pending', 'pending');
});

describe('free SMS', () => {
  it('queues, updates the conversation and timeline, then follows receipts to delivered', async () => {
    const t = await thread(orgA);
    const r = await sendText(orgA, t.conversationId, 'Your table is ready');
    expect(r.status).toBe(201);
    const sent = r.body.data as Msg;
    expect(sent).toMatchObject({
      conversationId: t.conversationId,
      channel: 'sms',
      direction: 'outbound',
      body: 'Your table is ready',
      status: 'queued',
      templateId: null,
      error: null,
      authorUserId: orgA.userId,
    });
    expect(sent.providerMessageId).toMatch(/^fake_msg_/);

    const conv = (await (
      await get(`/api/v1/conversations/${t.conversationId}`, orgA.cookie)
    ).json()) as Envelope<Conv>;
    expect(conv.data).toMatchObject({
      lastMessagePreview: 'Your table is ready',
      lastMessageDirection: 'outbound',
      lastMessageStatus: 'queued',
    });
    const timeline = (await (
      await get(`/api/v1/contacts/${t.contactId}/timeline`, orgA.cookie)
    ).json()) as Envelope<{ items: Array<{ kind: string; title: string }> }>;
    expect(timeline.data?.items.map((i) => i.title)).toContain('Outbound SMS');

    const allowed = await auditsOf(orgA, 'message.send', 'allowed');
    const mine = allowed.find((a) => a.entityId === sent.id);
    expect(mine).toBeDefined();
    expect(JSON.stringify(mine?.metadata)).not.toContain('table');

    await receipt(orgA, 'message.sent', sent.providerMessageId as string, t.phone);
    await receipt(orgA, 'message.delivered', sent.providerMessageId as string, t.phone);
    const detail = await messageDetail(orgA, sent.id);
    expect(detail.status).toBe(200);
    expect(detail.body.data?.status).toBe('delivered');
    expect(detail.body.data?.statusHistory.map((h) => h.status)).toEqual(['sent', 'delivered']);
    expect(detail.body.data?.statusHistory.every((h) => h.applied)).toBe(true);
  });
});

describe('replay', () => {
  it('answers 201 then 200 with the same message for a repeated clientMessageId', async () => {
    const t = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const first = await send(orgA, t.conversationId, { clientMessageId, body: 'Once only' });
    const second = await send(orgA, t.conversationId, { clientMessageId, body: 'Once only' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data?.id).toBe(first.body.data?.id);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(1);
  });

  it('keeps one row when the same clientMessageId races over HTTP', async () => {
    const t = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const results = await Promise.all([
      send(orgA, t.conversationId, { clientMessageId, body: 'Racing' }),
      send(orgA, t.conversationId, { clientMessageId, body: 'Racing' }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 201]);
    expect(results[0]?.body.data?.id).toBe(results[1]?.body.data?.id);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(1);
  });

  it('calls the provider exactly once for a concurrent replay', async () => {
    const t = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const { provider, calls } = countingProvider();
    // Two handles (each a pool of one), so the two sends really overlap.
    const sendOn = (db: Parameters<typeof sendMessage>[0]['db']) =>
      sendMessage({ db, env, tenant: tenantOf(orgA), provider }, t.conversationId, {
        clientMessageId,
        body: 'Exactly once',
      });
    const results = await withAppDb((db1) =>
      withAppDb((db2) => Promise.all([sendOn(db1), sendOn(db2)])),
    );
    expect(results.map((x) => x.kind).sort()).toEqual(['created', 'replayed']);
    expect(calls).toHaveLength(1);
    const [row] = await rowsByClientId(orgA, clientMessageId);
    expect(calls[0]?.idempotencyKey).toBe(row?.id);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(1);
  });

  it('lets the unique index decide a race across two conversations', async () => {
    const one = await thread(orgA);
    const two = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const { provider, calls } = countingProvider();
    const sendOn = (db: Parameters<typeof sendMessage>[0]['db'], conversationId: string) =>
      sendMessage({ db, env, tenant: tenantOf(orgA), provider }, conversationId, {
        clientMessageId,
        body: 'One of two',
      });
    const results = await withAppDb((db1) =>
      withAppDb((db2) =>
        Promise.all([sendOn(db1, one.conversationId), sendOn(db2, two.conversationId)]),
      ),
    );
    expect(results.map((x) => x.kind).sort()).toEqual(['created', 'replayed']);
    const ids = results.map((x) => (x.kind === 'error' ? null : x.message.id));
    expect(ids[0]).toBe(ids[1]);
    expect(calls).toHaveLength(1);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(1);
  });

  it('answers the winner when its own insert loses on the unique index (23505)', async () => {
    const one = await thread(orgA);
    const two = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const { provider, calls } = countingProvider();
    let winnerId = '';
    // Runs after the replay check and before the insert: a rival commits the same id first.
    const cost: MessageCostHook = {
      beforeSend: async () => {
        const row = await tenant(orgA, async (tx) => {
          const conv = await ensureConversation(tx, orgA.orgId, two.contactId, 'sms');
          return insertMessage(tx, {
            orgId: orgA.orgId,
            conversation: conv,
            direction: 'outbound',
            body: 'Rival',
            status: 'queued',
            provider: 'fake',
            clientMessageId,
            occurredAt: new Date(),
          });
        });
        winnerId = row.id;
        return { ok: true, decision: { outcome: 'ok', reason: 'ok' } };
      },
    };
    const result = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(orgA), cost, provider }, one.conversationId, {
        clientMessageId,
        body: 'Loser',
      }),
    );
    expect(result.kind).toBe('replayed');
    expect(result.kind === 'error' ? null : result.message.id).toBe(winnerId);
    expect(calls).toHaveLength(0);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(1);
  });
});

describe('gating', () => {
  it('refuses unknown consent with send_blocked and a denied audit', async () => {
    const t = await thread(orgA, { consent: false });
    const r = await sendText(orgA, t.conversationId, 'Hello');
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('send_blocked');
    expect(r.body.error?.message).toMatch(/^Messages to this contact are blocked: /);
    const denied = await auditsOf(orgA, 'message.send', 'denied');
    expect(
      denied.some((a) => (a.metadata as { reason?: string }).reason === 'consent_required'),
    ).toBe(true);
    expect(
      await tenant(orgA, (tx) =>
        tx.select().from(message).where(eq(message.conversationId, t.conversationId)),
      ),
    ).toHaveLength(0);
  });

  it('refuses a pending sandbox with send_paused', async () => {
    const t = await thread(pausedOrg);
    const r = await sendText(pausedOrg, t.conversationId, 'Hello');
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('send_paused');
    const denied = await auditsOf(pausedOrg, 'message.send', 'denied');
    expect(denied.map((a) => (a.metadata as { reason?: string }).reason)).toContain(
      'registration_pending',
    );
  });

  it('requires a template on WhatsApp without a recent inbound', async () => {
    const t = await thread(orgA, { channel: 'whatsapp' });
    const r = await sendText(orgA, t.conversationId, 'Free text');
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('template_required');
    const denied = await auditsOf(orgA, 'message.send', 'denied');
    expect(denied.map((a) => (a.metadata as { reason?: string }).reason)).toContain(
      'window_closed',
    );
  });

  it('sends an approved WhatsApp template outside the window', async () => {
    const t = await thread(orgA, { channel: 'whatsapp', name: 'Maya Okafor' });
    const tpl = await createTemplate(orgA, 'whatsapp', 'Hi {{first_name}}');
    const r = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: tpl.id,
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      body: 'Hi Maya',
      channel: 'whatsapp',
      templateId: tpl.id,
      templateName: tpl.name,
      status: 'queued',
    });
  });

  it('allows WhatsApp free text after a fresh inbound', async () => {
    const t = await thread(orgA, { channel: 'whatsapp' });
    await tenant(orgA, async (tx) => {
      const conv = await ensureConversation(tx, orgA.orgId, t.contactId, 'whatsapp');
      await insertMessage(tx, {
        orgId: orgA.orgId,
        conversation: conv,
        direction: 'inbound',
        body: 'Are you open?',
        status: 'received',
        provider: 'fake',
        providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
        occurredAt: new Date(),
      });
    });
    const r = await sendText(orgA, t.conversationId, 'Yes, until nine');
    expect(r.status).toBe(201);
    expect(r.body.data?.channel).toBe('whatsapp');
  });

  it('refuses when the cost hook declines, with no message row', async () => {
    const t = await thread(orgA);
    const clientMessageId = crypto.randomUUID();
    const cost: MessageCostHook = { beforeSend: async () => ({ ok: false, reason: 'stop_cap' }) };
    const { provider, calls } = countingProvider();
    const result = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(orgA), cost, provider }, t.conversationId, {
        clientMessageId,
        body: 'Costly',
      }),
    );
    expect(result).toMatchObject({
      kind: 'error',
      status: 402,
      code: 'spend_blocked',
      message: 'This message would pass the monthly spend cap.',
    });
    expect(calls).toHaveLength(0);
    expect(await rowsByClientId(orgA, clientMessageId)).toHaveLength(0);
    const denied = await auditsOf(orgA, 'message.send', 'denied');
    expect(denied.map((a) => (a.metadata as { reason?: string }).reason)).toContain('stop_cap');
  });
});

describe('template errors', () => {
  it('refuses an archived template with 422', async () => {
    const t = await thread(orgA);
    const tpl = await createTemplate(orgA, 'sms', 'Hello {{first_name}}');
    const archived = await post(`/api/v1/messaging/templates/${tpl.id}/archive`, orgA.cookie, {});
    expect(archived.status).toBe(200);
    const r = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: tpl.id,
    });
    expect(r.status).toBe(422);
    expect(r.body.error?.code).toBe('validation_error');
  });

  it("answers 404 for another organization's template", async () => {
    const t = await thread(orgA);
    const foreign = await createTemplate(orgB, 'sms', 'Hello {{first_name}}');
    const r = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: foreign.id,
    });
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('not_found');
  });

  it('names the missing value when the contact has no company', async () => {
    const t = await thread(orgA, { name: 'Lee Park' });
    const tpl = await createTemplate(orgA, 'sms', 'Hi {{first_name}} from {{company}}');
    const r = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: tpl.id,
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: 'validation_error',
      message: "This template needs {{company}}, which this contact doesn't have.",
    });
  });

  it('treats a name that is just the contact number as missing', async () => {
    const t = await thread(orgA, { nameIsPhone: true });
    const tpl = await createTemplate(orgA, 'sms', 'Hi {{first_name}}, thanks for writing');
    const r = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: tpl.id,
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toEqual({
      code: 'validation_error',
      message: "This template needs {{first_name}}, which this contact doesn't have.",
    });
    const plain = await createTemplate(orgA, 'sms', 'Thanks for writing');
    const ok = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: plain.id,
    });
    expect(ok.status).toBe(201);
  });

  it('refuses a WhatsApp template that is not approved, and one for another channel', async () => {
    const t = await thread(orgA, { channel: 'whatsapp' });
    const pending = await createTemplate(orgA, 'whatsapp', 'Hello {{first_name}}');
    await withAdminDb((db) =>
      db
        .update(messageTemplate)
        .set({ approvalStatus: 'pending' })
        .where(eq(messageTemplate.id, pending.id)),
    );
    const r1 = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: pending.id,
    });
    expect(r1.status).toBe(422);
    expect(r1.body.error?.code).toBe('validation_error');

    const smsTpl = await createTemplate(orgA, 'sms', 'Hello {{first_name}}');
    const r2 = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      templateId: smsTpl.id,
    });
    expect(r2.status).toBe(422);
    expect(r2.body.error?.code).toBe('validation_error');
  });
});

describe('provider failure', () => {
  it('marks the message failed with provider_error when the provider throws', async () => {
    const t = await thread(orgA);
    const result = await withAppDb((db) =>
      sendMessage(
        { db, env, tenant: tenantOf(orgA), provider: throwingProvider },
        t.conversationId,
        { clientMessageId: crypto.randomUUID(), body: 'Will not arrive' },
      ),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.status).toBe('failed');
    expect(result.message.error).toEqual({
      code: 'provider_error',
      message: 'The provider did not accept the message.',
    });
    expect(result.message.providerMessageId).toBeNull();

    const detail = await messageDetail(orgA, result.message.id);
    expect(detail.body.data?.statusHistory).toMatchObject([
      { status: 'failed', applied: true, errorCode: 'provider_error' },
    ]);
    const conv = (await (
      await get(`/api/v1/conversations/${t.conversationId}`, orgA.cookie)
    ).json()) as Envelope<Conv>;
    expect(conv.data?.lastMessageStatus).toBe('failed');
    const timeline = (await (
      await get(`/api/v1/contacts/${t.contactId}/timeline`, orgA.cookie)
    ).json()) as Envelope<{ items: Array<{ title: string }> }>;
    expect(timeline.data?.items.map((i) => i.title)).toContain('SMS failed to deliver');
  });
});

describe('body rules', () => {
  it('answers 400 for both body and templateId, neither, or a 1,601-character body', async () => {
    const t = await thread(orgA);
    const both = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      body: 'Hi',
      templateId: 'mt_00000000000000000000000000000000',
    });
    expect(both.status).toBe(400);
    const neither = await send(orgA, t.conversationId, { clientMessageId: crypto.randomUUID() });
    expect(neither.status).toBe(400);
    const long = await send(orgA, t.conversationId, {
      clientMessageId: crypto.randomUUID(),
      body: LONG_BODY,
    });
    expect(long.status).toBe(400);
    expect(long.body.error?.code).toBe('validation_error');
    const badClientId = await send(orgA, t.conversationId, { clientMessageId: 'nope', body: 'Hi' });
    expect(badClientId.status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it("answers 404 with a not_found audit when org B posts to org A's conversation", async () => {
    const t = await thread(orgA);
    const before = (await auditsOf(orgB, 'message.send', 'not_found')).length;
    const r = await sendText(orgB, t.conversationId, 'Intrusion');
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe('not_found');
    expect((await auditsOf(orgB, 'message.send', 'not_found')).length).toBe(before + 1);
    expect(
      await tenant(orgA, (tx) =>
        tx.select().from(message).where(eq(message.conversationId, t.conversationId)),
      ),
    ).toHaveLength(0);
  });

  it("answers 404 with a not_found audit for org A's message read from org B, and for a malformed id", async () => {
    const t = await thread(orgA);
    const sent = await sendText(orgA, t.conversationId, 'Private');
    const id = sent.body.data?.id as string;
    const before = (await auditsOf(orgB, 'message.read', 'not_found')).length;
    expect((await messageDetail(orgB, id)).status).toBe(404);
    expect((await messageDetail(orgB, 'garbage')).status).toBe(404);
    expect((await auditsOf(orgB, 'message.read', 'not_found')).length).toBe(before + 2);
    expect((await messageDetail(orgA, id)).status).toBe(200);
  });
});

describe('no live send while gated', () => {
  const sender = (provider: 'fake' | 'telnyx', live = true): Sender => ({
    id: 'cc_test',
    channel: 'sms',
    provider,
    address: 'sandbox:test',
    registrationStatus: 'approved',
    sandbox: provider === 'fake',
    liveEnabled: live,
  });
  const providerFor = (s: Sender, e: Env) => tenant(orgA, (tx) => messagingProviderFor(tx, s, e));

  it('returns a provider for the fake sender only with a secret outside production', async () => {
    expect(await providerFor(sender('fake'), env)).not.toBeNull();
    expect(
      await providerFor(sender('fake'), { ...env, FAKE_WEBHOOK_SECRET: undefined } as Env),
    ).toBeNull();
    expect(await providerFor(sender('fake'), { ...env, APP_ENV: 'production' } as Env)).toBeNull();
  });

  it('returns no provider for a telnyx sender that is not live, or has no saved credential', async () => {
    const flags = {
      ...env,
      PROVIDER: 'telnyx',
      SMS_10DLC_APPROVED: 'true',
      WHATSAPP_META_APPROVED: 'true',
    } as Env;
    expect(await providerFor(sender('telnyx', false), flags)).toBeNull();
    // orgA has no Telnyx credential in the vault.
    expect(await providerFor(sender('telnyx'), flags)).toBeNull();
  });
});

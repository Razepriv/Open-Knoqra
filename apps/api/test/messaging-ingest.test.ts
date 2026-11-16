import { env } from 'cloudflare:workers';
import { composerState, currentPermissions, type MessagingChannel } from '@knoqra/core';
import {
  auditEvent,
  channelConnection,
  channelRoute,
  contact,
  contactPermissionEvent,
  conversation,
  message,
  messageStatusEvent,
  providerEventRaw,
  type Tx,
  timelineEvent,
  withTenant,
} from '@knoqra/db';
import {
  FakeProvider,
  fakeMessageEvent,
  type MessageEventPayload,
  type ProviderEventType,
  toFakeWebhookBody,
} from '@knoqra/providers';
import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { latestPermissionEvents } from '../src/lib/permissions';
import { ensureConversation, insertMessage } from '../src/messaging/store';
import { handleProviderEvents } from '../src/queue/consumer';
import { mergeInto as mergeInTx } from '../src/routes/contact-duplicates';
import { ingestWebhook } from '../src/routes/webhooks';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

/*
 * End to end through the queue: `ingestWebhook` with a queue spy stores the raw event and records
 * the raw id, then `handleProviderEvents` runs on a fake batch of those ids with ack/retry spies.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type ChannelRow = { channel: string; status: string; source: string | null };
type TimelineItem = { kind: string; title: string; body: string | null };

interface Org {
  cookie: string;
  orgId: string;
  sms: string;
  whatsapp: string;
}

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });

let orgA: Org;
let orgB: Org;
let phoneSeq = 0;

const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, n * 2);
const pmid = () => `pm_${hex(8)}`;
/** Valid test numbers +1 202 555 01xx; each org is fresh per run, so a file-wide counter is enough. */
const nextPhone = () => {
  phoneSeq += 1;
  return `+1202555${String(100 + phoneSeq).padStart(4, '0')}`;
};

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

async function setupOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const orgId = await orgOf(cookie);
  const addresses: Record<MessagingChannel, string> = {
    sms: `sandbox:${hex(8)}`,
    whatsapp: `sandbox:${hex(8)}`,
  };
  await withAppDb((db) =>
    withTenant(db, orgId, async (tx) => {
      for (const channel of ['sms', 'whatsapp'] as const) {
        const [conn] = await tx
          .insert(channelConnection)
          .values({ organizationId: orgId, channel, provider: 'fake', address: addresses[channel] })
          .returning();
        if (!conn) throw new Error('connection insert failed');
        await tx.insert(channelRoute).values({
          organizationId: orgId,
          provider: 'fake',
          channel,
          address: addresses[channel],
          connectionId: conn.id,
        });
      }
    }),
  );
  return { cookie, orgId, sms: addresses.sms, whatsapp: addresses.whatsapp };
}

function newSpy() {
  const sent: string[] = [];
  const queue = { send: async (m: { rawEventId: string }) => void sent.push(m.rawEventId) };
  return { sent, env: { ...env, PROVIDER_EVENTS: queue } as unknown as Env };
}

/** Stores the event through the webhook path; returns the queued raw id (or undefined). */
async function deliver(body: string): Promise<string | undefined> {
  const spy = newSpy();
  const headers = new Headers({ 'x-fake-signature': await fake.signWebhook(body) });
  const result = await ingestWebhook(spy.env, fake, headers, new TextEncoder().encode(body));
  expect(result.status).toBe(200);
  return spy.sent[0];
}

function fakeBatch(ids: string[]) {
  const messages = ids.map((rawEventId) => ({
    id: rawEventId,
    timestamp: new Date(),
    attempts: 1,
    body: { rawEventId },
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  const batch = {
    queue: 'knoqra-provider-events',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ rawEventId: string }>;
  return { batch, messages };
}

async function processIds(ids: string[]) {
  const b = fakeBatch(ids);
  await handleProviderEvents(b.batch, env);
  return b.messages;
}

interface InboundOpts {
  channel?: MessagingChannel;
  occurredAt?: string;
  providerMessageId?: string;
}

function inboundBody(org: Org, from: string, text: string | undefined, opts: InboundOpts = {}) {
  const channel = opts.channel ?? 'sms';
  const payload: MessageEventPayload = { channel, from, to: org[channel] };
  if (text !== undefined) payload.body = text;
  return toFakeWebhookBody(
    fakeMessageEvent({
      type: 'message.received',
      providerMessageId: opts.providerMessageId ?? pmid(),
      payload,
      occurredAt: opts.occurredAt,
    }),
  );
}

/** Delivers and processes one inbound; returns the processed queue message. */
async function inbound(org: Org, from: string, text: string, opts: InboundOpts = {}) {
  const id = await deliver(inboundBody(org, from, text, opts));
  if (!id) throw new Error('not queued');
  const [msg] = await processIds([id]);
  return { rawEventId: id, msg };
}

function receiptBody(
  org: Org,
  type: ProviderEventType,
  providerMessageId: string,
  opts: { eventId?: string; error?: { code: string; message: string } } = {},
) {
  const payload: MessageEventPayload = { channel: 'sms', from: org.sms, to: '+12025550199' };
  if (opts.error) payload.error = opts.error;
  return toFakeWebhookBody(
    fakeMessageEvent({ type, providerMessageId, payload, eventId: opts.eventId }),
  );
}

async function receipt(
  org: Org,
  type: ProviderEventType,
  providerMessageId: string,
  eventId?: string,
) {
  const id = await deliver(receiptBody(org, type, providerMessageId, { eventId }));
  if (!id) throw new Error('not queued');
  const [msg] = await processIds([id]);
  return { rawEventId: id, msg };
}

const tenant = <T>(org: Org, fn: Parameters<typeof withTenant<T>>[2]) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

const contactsByPhone = (org: Org, phone: string) =>
  tenant(org, (tx) =>
    tx
      .select()
      .from(contact)
      .where(and(eq(contact.organizationId, org.orgId), eq(contact.phoneE164, phone))),
  );

const contactByPhone = async (org: Org, phone: string) => (await contactsByPhone(org, phone))[0];

const conversationsOf = (org: Org, contactId: string) =>
  tenant(org, (tx) => tx.select().from(conversation).where(eq(conversation.contactId, contactId)));

const messagesByProviderId = (org: Org, providerMessageId: string) =>
  tenant(org, (tx) =>
    tx.select().from(message).where(eq(message.providerMessageId, providerMessageId)),
  );

const timelineOf = (org: Org, contactId: string) =>
  tenant(org, (tx) =>
    tx.select().from(timelineEvent).where(eq(timelineEvent.contactId, contactId)),
  );

const rawRow = async (id: string) => {
  const [row] = await withAdminDb((db) =>
    db.select().from(providerEventRaw).where(eq(providerEventRaw.id, id)),
  );
  return row;
};

/** An outbound message waiting for receipts, created through the store. */
async function outbound(org: Org, status: 'queued' | 'sent' = 'queued') {
  const phone = nextPhone();
  const providerMessageId = pmid();
  const row = await tenant(org, async (tx) => {
    const [c] = await tx
      .insert(contact)
      .values({ organizationId: org.orgId, displayName: 'Receipt', phoneE164: phone })
      .returning();
    if (!c) throw new Error('contact insert failed');
    const conv = await ensureConversation(tx, org.orgId, c.id, 'sms');
    return insertMessage(tx, {
      orgId: org.orgId,
      conversation: conv,
      direction: 'outbound',
      body: 'Your order shipped',
      status,
      provider: 'fake',
      providerMessageId,
      occurredAt: new Date(),
    });
  });
  return { providerMessageId, messageId: row.id, conversationId: row.conversationId, phone };
}

const statusEventsOf = (org: Org, messageId: string) =>
  tenant(org, (tx) =>
    tx
      .select()
      .from(messageStatusEvent)
      .where(eq(messageStatusEvent.messageId, messageId))
      .orderBy(messageStatusEvent.createdAt, messageStatusEvent.id),
  );

async function smsPermission(org: Org, contactId: string, channel = 'sms') {
  const r = await get(`/api/v1/contacts/${contactId}/permissions`, org.cookie);
  const body = (await r.json()) as Envelope<{ channels: ChannelRow[] }>;
  return body.data?.channels.find((c) => c.channel === channel);
}

async function timelineApi(org: Org, contactId: string): Promise<TimelineItem[]> {
  const r = await get(`/api/v1/contacts/${contactId}/timeline`, org.cookie);
  return ((await r.json()) as Envelope<{ items: TimelineItem[] }>).data?.items ?? [];
}

beforeAll(async () => {
  orgA = await setupOrg('mi-a');
  orgB = await setupOrg('mi-b');
});

describe('inbound SMS from an unknown number', () => {
  it('creates the contact, conversation, received message and timeline entry, and acks', async () => {
    const phone = nextPhone();
    const providerMessageId = pmid();
    const { rawEventId, msg } = await inbound(orgA, phone, 'Hi, is the order ready?', {
      providerMessageId,
    });
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    expect(msg?.retry).not.toHaveBeenCalled();
    expect((await rawRow(rawEventId))?.processedAt).toBeInstanceOf(Date);

    const ct = await contactByPhone(orgA, phone);
    expect(ct).toMatchObject({
      source: 'inbound',
      sourceDetail: 'Inbound SMS',
      displayName: phone,
    });
    const convs = await conversationsOf(orgA, ct?.id as string);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({
      channel: 'sms',
      unreadCount: 1,
      lastMessagePreview: 'Hi, is the order ready?',
      lastMessageDirection: 'inbound',
      lastMessageStatus: 'received',
    });
    const msgs = await messagesByProviderId(orgA, providerMessageId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      status: 'received',
      direction: 'inbound',
      contactId: ct?.id,
      conversationId: convs[0]?.id,
    });
    const tl = await timelineOf(orgA, ct?.id as string);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({
      kind: 'message',
      title: 'Inbound SMS',
      body: 'Hi, is the order ready?',
      refType: 'message',
      refId: msgs[0]?.id,
    });
  });
});

describe('inbound contact resolution', () => {
  it('an unknown number creates exactly one contact, also when two inbounds race', async () => {
    const phone = nextPhone();
    const first = pmid();
    const second = pmid();
    const ids = [
      (await deliver(inboundBody(orgA, phone, 'one', { providerMessageId: first }))) as string,
      (await deliver(inboundBody(orgA, phone, 'two', { providerMessageId: second }))) as string,
    ];
    const results = await Promise.all(ids.map((id) => processIds([id])));
    for (const [m] of results) {
      expect(m?.ack).toHaveBeenCalledTimes(1);
      expect(m?.retry).not.toHaveBeenCalled();
    }
    const holders = await contactsByPhone(orgA, phone);
    expect(holders).toHaveLength(1);
    const [a] = await messagesByProviderId(orgA, first);
    const [b] = await messagesByProviderId(orgA, second);
    expect(a?.contactId).toBe(holders[0]?.id);
    expect(b?.contactId).toBe(holders[0]?.id);
    expect(await conversationsOf(orgA, holders[0]?.id as string)).toHaveLength(1);
  });

  it('an inbound from a number an unmerged contact holds uses that contact', async () => {
    // Under the current full UNIQUE(organization_id, phone_e164) a merged and an unmerged contact
    // cannot share a number, so the fixture for "unmerged wins over a merged twin" is only
    // possible once the partial index over unmerged contacts lands. Here: the holder is used and
    // an unrelated merge in the org does not divert it.
    const phone = nextPhone();
    const [holder, oldOne, kept] = await tenant(orgA, async (tx) =>
      tx
        .insert(contact)
        .values([
          { organizationId: orgA.orgId, displayName: 'Holder', phoneE164: phone },
          { organizationId: orgA.orgId, displayName: 'Old', phoneE164: nextPhone() },
          { organizationId: orgA.orgId, displayName: 'Kept', phoneE164: nextPhone() },
        ])
        .returning(),
    );
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: kept?.id })
        .where(and(eq(contact.id, oldOne?.id as string), eq(contact.organizationId, orgA.orgId))),
    );
    const providerMessageId = pmid();
    const { msg } = await inbound(orgA, phone, 'still me', { providerMessageId });
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    const [row] = await messagesByProviderId(orgA, providerMessageId);
    expect(row?.contactId).toBe(holder?.id);
    expect(await contactsByPhone(orgA, phone)).toHaveLength(1);
  });
});

describe('duplicates', () => {
  it('ingesting the same webhook twice leaves one message', async () => {
    const providerMessageId = pmid();
    const body = inboundBody(orgA, nextPhone(), 'twice', { providerMessageId });
    const first = await deliver(body);
    const second = await deliver(body);
    expect(second).toBeUndefined();
    await processIds([first as string]);
    await processIds([first as string]);
    expect(await messagesByProviderId(orgA, providerMessageId)).toHaveLength(1);
  });

  it('the same raw id twice in one batch leaves one message, one unread, one timeline row', async () => {
    const phone = nextPhone();
    const providerMessageId = pmid();
    const id = (await deliver(inboundBody(orgA, phone, 'batch', { providerMessageId }))) as string;
    const msgs = await processIds([id, id]);
    for (const m of msgs) expect(m.ack).toHaveBeenCalledTimes(1);
    expect(await messagesByProviderId(orgA, providerMessageId)).toHaveLength(1);
    const ct = await contactByPhone(orgA, phone);
    expect((await conversationsOf(orgA, ct?.id as string))[0]?.unreadCount).toBe(1);
    expect(await timelineOf(orgA, ct?.id as string)).toHaveLength(1);
  });

  it('concurrent processing of one raw id leaves one message, one unread, one timeline row', async () => {
    const phone = nextPhone();
    const providerMessageId = pmid();
    const id = (await deliver(inboundBody(orgA, phone, 'race', { providerMessageId }))) as string;
    const results = await Promise.all([processIds([id]), processIds([id]), processIds([id])]);
    for (const [m] of results) {
      expect(m?.ack).toHaveBeenCalledTimes(1);
      expect(m?.retry).not.toHaveBeenCalled();
    }
    expect(await messagesByProviderId(orgA, providerMessageId)).toHaveLength(1);
    const ct = await contactByPhone(orgA, phone);
    expect((await conversationsOf(orgA, ct?.id as string))[0]?.unreadCount).toBe(1);
    expect(await timelineOf(orgA, ct?.id as string)).toHaveLength(1);
  });
});

describe('receipts', () => {
  it('sent, delivered, read ends read with three applied status events', async () => {
    const out = await outbound(orgA);
    for (const type of ['message.sent', 'message.delivered', 'message.read'] as const) {
      const { msg } = await receipt(orgA, type, out.providerMessageId);
      expect(msg?.ack).toHaveBeenCalledTimes(1);
    }
    const [row] = await messagesByProviderId(orgA, out.providerMessageId);
    expect(row?.status).toBe('read');
    const events = await statusEventsOf(orgA, out.messageId);
    expect(events.map((e) => [e.status, e.applied])).toEqual([
      ['sent', true],
      ['delivered', true],
      ['read', true],
    ]);
    const conv = await tenant(orgA, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, out.conversationId)),
    );
    expect(conv[0]?.lastMessageStatus).toBe('read');
  });

  it('delivered then sent stays delivered and records sent as not applied', async () => {
    const out = await outbound(orgA);
    await receipt(orgA, 'message.delivered', out.providerMessageId);
    await receipt(orgA, 'message.sent', out.providerMessageId);
    const [row] = await messagesByProviderId(orgA, out.providerMessageId);
    expect(row?.status).toBe('delivered');
    const events = await statusEventsOf(orgA, out.messageId);
    expect(events.map((e) => [e.status, e.applied])).toEqual([
      ['delivered', true],
      ['sent', false],
    ]);
  });

  it('a duplicate delivery receipt changes nothing', async () => {
    const out = await outbound(orgA);
    await receipt(orgA, 'message.delivered', out.providerMessageId);
    const [before] = await messagesByProviderId(orgA, out.providerMessageId);
    const { msg } = await receipt(
      orgA,
      'message.delivered',
      out.providerMessageId,
      `dup_${hex(8)}`,
    );
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    const [after] = await messagesByProviderId(orgA, out.providerMessageId);
    expect(after?.status).toBe('delivered');
    expect(after?.statusUpdatedAt).toEqual(before?.statusUpdatedAt);
    const events = await statusEventsOf(orgA, out.messageId);
    expect(events.map((e) => [e.status, e.applied])).toEqual([
      ['delivered', true],
      ['delivered', false],
    ]);
  });

  it('failed stores the error and adds "SMS failed to deliver" to the timeline', async () => {
    const out = await outbound(orgA, 'sent');
    const error = { code: '30003', message: 'Unreachable handset' };
    const id = await deliver(receiptBody(orgA, 'message.failed', out.providerMessageId, { error }));
    const [msg] = await processIds([id as string]);
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    const [row] = await messagesByProviderId(orgA, out.providerMessageId);
    expect(row).toMatchObject({
      status: 'failed',
      errorCode: '30003',
      errorMessage: 'Unreachable handset',
    });
    const ct = await contactByPhone(orgA, out.phone);
    const titles = (await timelineOf(orgA, ct?.id as string)).map((t) => t.title);
    expect(titles).toContain('SMS failed to deliver');
    const events = await statusEventsOf(orgA, out.messageId);
    expect(events.at(-1)).toMatchObject({ status: 'failed', applied: true, errorCode: '30003' });
  });
});

describe('unknown and invalid events', () => {
  it('a receipt for an unknown message retries, leaves the raw row unprocessed, writes nothing', async () => {
    const providerMessageId = pmid();
    const id = (await deliver(receiptBody(orgA, 'message.delivered', providerMessageId))) as string;
    const [msg] = await processIds([id]);
    expect(msg?.retry).toHaveBeenCalledTimes(1);
    expect(msg?.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(msg?.ack).not.toHaveBeenCalled();
    expect((await rawRow(id))?.processedAt).toBeNull();
    const events = await withAdminDb((db) =>
      db.select().from(messageStatusEvent).where(eq(messageStatusEvent.rawEventId, id)),
    );
    expect(events).toHaveLength(0);
  });

  it('an event to an address with no route is acked and processed, no rows', async () => {
    const providerMessageId = pmid();
    const phone = nextPhone();
    const body = toFakeWebhookBody(
      fakeMessageEvent({
        type: 'message.received',
        providerMessageId,
        payload: { channel: 'sms', from: phone, to: `sandbox:${hex(8)}`, body: 'hello?' },
      }),
    );
    const id = (await deliver(body)) as string;
    const [msg] = await processIds([id]);
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    expect((await rawRow(id))?.processedAt).toBeInstanceOf(Date);
    const rows = await withAdminDb((db) =>
      db.select().from(message).where(eq(message.providerMessageId, providerMessageId)),
    );
    expect(rows).toHaveLength(0);
    const contacts = await withAdminDb((db) =>
      db
        .select()
        .from(contact)
        .where(and(eq(contact.phoneE164, phone), eq(contact.organizationId, orgA.orgId))),
    );
    expect(contacts).toHaveLength(0);
  });

  it('an invalid payload (received without a body) is acked and processed', async () => {
    const providerMessageId = pmid();
    const id = (await deliver(
      inboundBody(orgA, nextPhone(), undefined, { providerMessageId }),
    )) as string;
    const [msg] = await processIds([id]);
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    expect(msg?.retry).not.toHaveBeenCalled();
    expect((await rawRow(id))?.processedAt).toBeInstanceOf(Date);
    const rows = await withAdminDb((db) =>
      db.select().from(message).where(eq(message.providerMessageId, providerMessageId)),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('keywords', () => {
  it('" Stop. " opts SMS out by reply and blocks the composer', async () => {
    const phone = nextPhone();
    await inbound(orgA, phone, ' Stop. ');
    const ct = await contactByPhone(orgA, phone);
    const sms = await smsPermission(orgA, ct?.id as string);
    expect(sms).toMatchObject({ status: 'opted_out', source: 'inbound_stop' });
    const consent = await tenant(orgA, async (tx) =>
      currentPermissions(await latestPermissionEvents(tx, ct?.id as string)),
    );
    const evidence = await tenant(orgA, async (tx) =>
      (await latestPermissionEvents(tx, ct?.id as string)).find((e) => e.channel === 'sms'),
    );
    expect(evidence?.evidence).toBe('Replied "Stop."');
    expect(
      composerState({
        channel: 'sms',
        consent: consent.sms,
        sender: { registrationStatus: 'approved', liveEnabled: true },
        lastInboundAt: null,
        now: new Date(),
      }),
    ).toMatchObject({ mode: 'blocked', reason: 'opted_out' });
    const titles = (await timelineApi(orgA, ct?.id as string)).map((t) => t.title);
    expect(titles).toContain('SMS opted out by reply STOP');
  });

  it('START grants SMS with source inbound_start', async () => {
    const phone = nextPhone();
    await inbound(orgA, phone, 'STOP');
    await inbound(orgA, phone, 'START');
    const ct = await contactByPhone(orgA, phone);
    expect(await smsPermission(orgA, ct?.id as string)).toMatchObject({
      status: 'granted',
      source: 'inbound_start',
    });
  });

  /** An inbound-created contact, then marked do not contact through the M1 endpoint. */
  async function dncContact(): Promise<{ phone: string; id: string }> {
    const phone = nextPhone();
    await inbound(orgA, phone, 'hello');
    const ct = await contactByPhone(orgA, phone);
    const dnc = await api(`/api/v1/contacts/${ct?.id}/do-not-contact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: orgA.cookie },
      body: JSON.stringify({}),
    });
    expect(dnc.status).toBe(200);
    return { phone, id: ct?.id as string };
  }

  const permissionEventCount = (contactId: string) =>
    tenant(
      orgA,
      async (tx) =>
        (
          await tx
            .select()
            .from(contactPermissionEvent)
            .where(eq(contactPermissionEvent.contactId, contactId))
        ).length,
    );

  it('STOP after a manual do not contact keeps do_not_contact and records no permission event', async () => {
    const { phone, id } = await dncContact();
    const before = await permissionEventCount(id);
    await inbound(orgA, phone, 'STOP');
    expect(await smsPermission(orgA, id)).toMatchObject({
      status: 'do_not_contact',
      source: 'manual',
    });
    expect(await permissionEventCount(id)).toBe(before);
    const titles = (await timelineApi(orgA, id)).map((t) => t.title);
    expect(titles).toContain('STOP received · contact stays Do not contact');
    expect(titles).not.toContain('SMS opted out by reply STOP');
  });

  it('do not contact, then STOP, then START stays do_not_contact and blocked', async () => {
    const { phone, id } = await dncContact();
    await inbound(orgA, phone, 'STOP');
    await inbound(orgA, phone, 'START');
    expect((await smsPermission(orgA, id))?.status).toBe('do_not_contact');
    const consent = await tenant(orgA, async (tx) =>
      currentPermissions(await latestPermissionEvents(tx, id)),
    );
    expect(
      composerState({
        channel: 'sms',
        consent: consent.sms,
        sender: { registrationStatus: 'approved', liveEnabled: true },
        lastInboundAt: null,
        now: new Date(),
      }),
    ).toMatchObject({ mode: 'blocked', reason: 'do_not_contact' });
    const titles = (await timelineApi(orgA, id)).map((t) => t.title);
    expect(titles).toContain('STOP received · contact stays Do not contact');
    expect(titles).toContain('START received · contact stays Do not contact');
  });

  it('START after a manual do not contact keeps do_not_contact and says so', async () => {
    const { phone, id } = await dncContact();
    await inbound(orgA, phone, 'START');
    expect((await smsPermission(orgA, id))?.status).toBe('do_not_contact');
    const titles = (await timelineApi(orgA, id)).map((t) => t.title);
    expect(titles).toContain('START received · contact stays Do not contact');
  });

  it('a WhatsApp STOP leaves SMS consent untouched', async () => {
    const phone = nextPhone();
    await inbound(orgA, phone, 'hi');
    const ct = await contactByPhone(orgA, phone);
    const put = await api(`/api/v1/contacts/${ct?.id}/permissions/sms`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: orgA.cookie },
      body: JSON.stringify({ status: 'granted' }),
    });
    expect(put.status).toBe(200);
    await inbound(orgA, phone, 'stop', { channel: 'whatsapp' });
    expect(await smsPermission(orgA, ct?.id as string)).toMatchObject({
      status: 'granted',
      source: 'manual',
    });
    expect(await smsPermission(orgA, ct?.id as string, 'whatsapp')).toMatchObject({
      status: 'opted_out',
      source: 'inbound_stop',
    });
    const titles = (await timelineApi(orgA, ct?.id as string)).map((t) => t.title);
    expect(titles).toContain('WhatsApp opted out by reply STOP');
  });
});

describe('WhatsApp window', () => {
  it('lastInboundAt is the provider instant and an older inbound does not move it back', async () => {
    const phone = nextPhone();
    const at = new Date(Date.now() - 25 * 3_600_000);
    await inbound(orgA, phone, 'first', { channel: 'whatsapp', occurredAt: at.toISOString() });
    const ct = await contactByPhone(orgA, phone);
    const read = async () =>
      (await conversationsOf(orgA, ct?.id as string)).find((c) => c.channel === 'whatsapp');
    expect((await read())?.lastInboundAt).toEqual(at);
    const older = new Date(at.getTime() - 5 * 3_600_000);
    await inbound(orgA, phone, 'late', { channel: 'whatsapp', occurredAt: older.toISOString() });
    const conv = await read();
    expect(conv?.lastInboundAt).toEqual(at);
    expect(conv?.unreadCount).toBe(2);
    expect(conv?.lastMessagePreview).toBe('first');
    expect(ct?.sourceDetail).toBe('Inbound WhatsApp');
  });
});

describe('isolation', () => {
  it("an inbound to org A's address is invisible to org B", async () => {
    const phone = nextPhone();
    const providerMessageId = pmid();
    await inbound(orgA, phone, 'for A only', { providerMessageId });
    const ct = await contactByPhone(orgA, phone);
    const convA = await conversationsOf(orgA, ct?.id as string);
    expect(convA).toHaveLength(1);
    const convB = await tenant(orgB, (tx) =>
      tx
        .select()
        .from(conversation)
        .where(eq(conversation.id, convA[0]?.id as string)),
    );
    expect(convB).toHaveLength(0);
    expect(await messagesByProviderId(orgB, providerMessageId)).toHaveLength(0);
    expect(await contactByPhone(orgB, phone)).toBeUndefined();
  });
});

describe('merges', () => {
  it("an inbound from a merged contact's phone lands on the merge target", async () => {
    const sourcePhone = nextPhone();
    const targetPhone = nextPhone();
    const [source, target] = await tenant(orgA, async (tx) =>
      tx
        .insert(contact)
        .values([
          { organizationId: orgA.orgId, displayName: 'Old', phoneE164: sourcePhone },
          { organizationId: orgA.orgId, displayName: 'Kept', phoneE164: targetPhone },
        ])
        .returning(),
    );
    await withAdminDb((db) =>
      db
        .update(contact)
        .set({ mergedIntoId: target?.id })
        .where(and(eq(contact.id, source?.id as string), eq(contact.organizationId, orgA.orgId))),
    );
    const providerMessageId = pmid();
    await inbound(orgA, sourcePhone, 'after merge', { providerMessageId });
    const [row] = await messagesByProviderId(orgA, providerMessageId);
    expect(row?.contactId).toBe(target?.id);
    expect(await conversationsOf(orgA, source?.id as string)).toHaveLength(0);
    expect(await conversationsOf(orgA, target?.id as string)).toHaveLength(1);
    // No new contact was created for the merged source's number.
    expect(await contactsByPhone(orgA, sourcePhone)).toHaveLength(1);
  });
});

async function userOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
  }>;
  const id = body.data?.user.id;
  if (!id) throw new Error('no signed-in user');
  return id;
}

async function backendPid(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number((result.rows[0] as { pid: number }).pid);
}

const LOCK_WAIT_LIMIT_MS = 10_000;

/**
 * Polls, on its own admin connection, until some session waits on a lock held by `holder`, or
 * until `done()` says the racing work already finished without waiting.
 */
async function waitUntilBlockedBy(holder: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    const blocked = await withAdminDb(async (db) => {
      const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where ${holder} = any(pg_blocking_pids(pid))`);
      return Number((result.rows[0] as { n: number }).n);
    });
    if (blocked > 0 || done()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the racing inbound never waited on the merge');
}

describe('merging contacts moves their conversations', () => {
  /** Instants a minute ago, one second apart, so the order of seeded messages is fixed. */
  const base = Date.now() - 60_000;
  const at = (second: number) => new Date(base + second * 1000).toISOString();

  async function pair() {
    const sourcePhone = nextPhone();
    const targetPhone = nextPhone();
    const [source, target] = await tenant(orgA, async (tx) =>
      tx
        .insert(contact)
        .values([
          { organizationId: orgA.orgId, displayName: 'Merge source', phoneE164: sourcePhone },
          { organizationId: orgA.orgId, displayName: 'Merge target', phoneE164: targetPhone },
        ])
        .returning(),
    );
    if (!source || !target) throw new Error('contact insert failed');
    return { source, target, sourcePhone, targetPhone };
  }

  async function mergeInto(targetId: string, sourceId: string) {
    const r = await post(`/api/v1/contacts/${targetId}/merge`, orgA.cookie, { sourceId });
    expect(r.status).toBe(200);
  }

  const messagesOf = (conversationId: string) =>
    tenant(orgA, (tx) =>
      tx
        .select()
        .from(message)
        .where(eq(message.conversationId, conversationId))
        .orderBy(asc(message.occurredAt), asc(message.id)),
    );

  const conversationById = async (id: string) =>
    (await tenant(orgA, (tx) => tx.select().from(conversation).where(eq(conversation.id, id))))[0];

  /** A queued outbound SMS on the contact's thread (created if missing), at `at(second)`. */
  async function outboundOn(contactId: string, body: string, second: number) {
    const providerMessageId = pmid();
    const row = await tenant(orgA, async (tx) => {
      const conv = await ensureConversation(tx, orgA.orgId, contactId, 'sms');
      return insertMessage(tx, {
        orgId: orgA.orgId,
        conversation: conv,
        direction: 'outbound',
        body,
        status: 'queued',
        provider: 'fake',
        providerMessageId,
        occurredAt: new Date(at(second)),
      });
    });
    return { messageId: row.id, providerMessageId };
  }

  const mergeAudits = (targetId: string) =>
    tenant(orgA, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'contact.merge'), eq(auditEvent.entityId, targetId))),
    );

  /** Both contacts hold an SMS thread: target t1 in, source t2 in, target t3 out, source t4 in. */
  async function bothThreads() {
    const p = await pair();
    await inbound(orgA, p.targetPhone, 'Target first', { occurredAt: at(1) });
    await inbound(orgA, p.sourcePhone, 'Source second', { occurredAt: at(2) });
    await outboundOn(p.target.id, 'Target reply', 3);
    await inbound(orgA, p.sourcePhone, 'Source latest', { occurredAt: at(4) });
    const [sourceConv] = await conversationsOf(orgA, p.source.id);
    const [targetConv] = await conversationsOf(orgA, p.target.id);
    if (!sourceConv || !targetConv) throw new Error('threads not seeded');
    expect(sourceConv.unreadCount).toBe(2);
    expect(targetConv.unreadCount).toBe(1);
    return { ...p, sourceConv, targetConv };
  }

  it('re-points the only thread when just the source has one', async () => {
    const p = await pair();
    await inbound(orgA, p.sourcePhone, 'Only the source wrote', { occurredAt: at(1) });
    const [before] = await conversationsOf(orgA, p.source.id);
    if (!before) throw new Error('thread not seeded');

    await mergeInto(p.target.id, p.source.id);

    expect(await conversationsOf(orgA, p.source.id)).toHaveLength(0);
    const after = await conversationsOf(orgA, p.target.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before.id,
      contactId: p.target.id,
      unreadCount: 1,
      lastMessagePreview: 'Only the source wrote',
      lastMessageDirection: 'inbound',
    });
    const msgs = await messagesOf(before.id);
    expect(msgs.map((m) => m.contactId)).toEqual([p.target.id]);
  });

  it('folds both threads on one channel into the target thread, in order', async () => {
    const p = await bothThreads();
    const statusEventsBefore = await tenant(orgA, (tx) => tx.select().from(messageStatusEvent));

    await mergeInto(p.target.id, p.source.id);

    expect(await conversationsOf(orgA, p.source.id)).toHaveLength(0);
    expect(await conversationById(p.sourceConv.id)).toBeUndefined();
    const after = await conversationsOf(orgA, p.target.id);
    expect(after).toHaveLength(1);
    const kept = after[0];
    expect(kept?.id).toBe(p.targetConv.id);
    const msgs = await messagesOf(p.targetConv.id);
    expect(msgs.map((m) => m.body)).toEqual([
      'Target first',
      'Source second',
      'Target reply',
      'Source latest',
    ]);
    expect(new Set(msgs.map((m) => m.contactId))).toEqual(new Set([p.target.id]));
    expect(kept).toMatchObject({
      unreadCount: 3,
      lastMessagePreview: 'Source latest',
      lastMessageDirection: 'inbound',
      lastMessageStatus: 'received',
    });
    // The WhatsApp-style window follows the newest inbound of either thread.
    expect(kept?.lastInboundAt?.toISOString()).toBe(at(4));
    const latestActivity = Math.max(
      p.sourceConv.lastActivityAt.getTime(),
      p.targetConv.lastActivityAt.getTime(),
    );
    expect(kept?.lastActivityAt.getTime()).toBe(latestActivity);
    // Delivery history is untouched: it references message ids, which do not change.
    expect(await tenant(orgA, (tx) => tx.select().from(messageStatusEvent))).toEqual(
      statusEventsBefore,
    );
  });

  it("an inbound to the source's old number lands in the target thread after the merge", async () => {
    const p = await bothThreads();
    await mergeInto(p.target.id, p.source.id);

    const providerMessageId = pmid();
    await inbound(orgA, p.sourcePhone, 'After the merge', { providerMessageId, occurredAt: at(5) });

    const [row] = await messagesByProviderId(orgA, providerMessageId);
    expect(row).toMatchObject({ contactId: p.target.id, conversationId: p.targetConv.id });
    expect(await conversationsOf(orgA, p.source.id)).toHaveLength(0);
    const after = await conversationsOf(orgA, p.target.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      unreadCount: 4,
      lastMessagePreview: 'After the merge',
    });
    expect(after[0]?.lastInboundAt?.toISOString()).toBe(at(5));
  });

  it('folds the SMS thread and re-points the WhatsApp thread in one merge, and audits both', async () => {
    const p = await pair();
    await inbound(orgA, p.targetPhone, 'Target SMS', { occurredAt: at(1) });
    await inbound(orgA, p.sourcePhone, 'Source SMS', { occurredAt: at(2) });
    await inbound(orgA, p.sourcePhone, 'Source WhatsApp', {
      channel: 'whatsapp',
      occurredAt: at(3),
    });
    const sourceThreads = await conversationsOf(orgA, p.source.id);
    const sourceSms = sourceThreads.find((c) => c.channel === 'sms');
    const sourceWhatsApp = sourceThreads.find((c) => c.channel === 'whatsapp');
    const [targetSms] = await conversationsOf(orgA, p.target.id);
    if (!sourceSms || !sourceWhatsApp || !targetSms) throw new Error('threads not seeded');

    await mergeInto(p.target.id, p.source.id);

    expect(await conversationsOf(orgA, p.source.id)).toHaveLength(0);
    expect(await conversationById(sourceSms.id)).toBeUndefined();
    const after = await conversationsOf(orgA, p.target.id);
    expect(Object.fromEntries(after.map((c) => [c.channel, c.id]))).toEqual({
      sms: targetSms.id,
      whatsapp: sourceWhatsApp.id,
    });
    expect((await messagesOf(targetSms.id)).map((m) => m.body)).toEqual([
      'Target SMS',
      'Source SMS',
    ]);
    const whatsApp = await messagesOf(sourceWhatsApp.id);
    expect(whatsApp.map((m) => [m.body, m.contactId])).toEqual([['Source WhatsApp', p.target.id]]);
    // The audit names the threads (ids only), so notes on a folded thread can be found later.
    const [audit] = await mergeAudits(p.target.id);
    expect(audit?.metadata).toMatchObject({
      sourceId: p.source.id,
      conversations: {
        moved: [sourceWhatsApp.id],
        folded: [{ from: sourceSms.id, into: targetSms.id }],
      },
    });
  });

  it('recomputes the folded summary when the target holds the latest message and newest inbound', async () => {
    const p = await pair();
    await inbound(orgA, p.targetPhone, 'Target newest inbound', { occurredAt: at(3) });
    await outboundOn(p.target.id, 'Target latest', 4);
    // The source thread is written last, but its messages are older.
    await inbound(orgA, p.sourcePhone, 'Source older one', { occurredAt: at(1) });
    await inbound(orgA, p.sourcePhone, 'Source older two', { occurredAt: at(2) });
    const [sourceConv] = await conversationsOf(orgA, p.source.id);
    const [targetConv] = await conversationsOf(orgA, p.target.id);
    if (!sourceConv || !targetConv) throw new Error('threads not seeded');
    expect(sourceConv.lastMessagePreview).toBe('Source older two');

    await mergeInto(p.target.id, p.source.id);

    const kept = await conversationById(targetConv.id);
    expect(kept).toMatchObject({
      unreadCount: 3,
      lastMessagePreview: 'Target latest',
      lastMessageDirection: 'outbound',
      lastMessageStatus: 'queued',
    });
    expect(kept?.lastInboundAt?.toISOString()).toBe(at(3));
    expect((await messagesOf(targetConv.id)).map((m) => m.body)).toEqual([
      'Source older one',
      'Source older two',
      'Target newest inbound',
      'Target latest',
    ]);
  });

  it("keeps a moved message's delivery history, still shown in the message detail", async () => {
    const p = await pair();
    await inbound(orgA, p.sourcePhone, 'Source asks', { occurredAt: at(1) });
    const sent = await outboundOn(p.source.id, 'Source answer', 2);
    await receipt(orgA, 'message.sent', sent.providerMessageId);
    await inbound(orgA, p.targetPhone, 'Target writes', { occurredAt: at(3) });
    const [targetConv] = await conversationsOf(orgA, p.target.id);
    if (!targetConv) throw new Error('thread not seeded');
    const eventsBefore = await statusEventsOf(orgA, sent.messageId);
    expect(eventsBefore.map((e) => [e.status, e.applied])).toEqual([['sent', true]]);

    await mergeInto(p.target.id, p.source.id);

    expect(await statusEventsOf(orgA, sent.messageId)).toEqual(eventsBefore);
    const r = await get(`/api/v1/messages/${sent.messageId}`, orgA.cookie);
    expect(r.status).toBe(200);
    const detail = (await r.json()) as Envelope<{
      conversationId: string;
      status: string;
      statusHistory: { status: string; applied: boolean }[];
    }>;
    expect(detail.data).toMatchObject({
      conversationId: targetConv.id,
      status: 'sent',
      statusHistory: [{ status: 'sent', applied: true }],
    });
  });

  it('an inbound STOP racing the merge waits for it, then lands on the target', async () => {
    const p = await bothThreads();
    const userId = await userOf(orgA.cookie);
    const providerMessageId = pmid();
    let settled = false;
    let pending: Promise<unknown> = Promise.resolve();
    await withAppDb((db) =>
      withTenant(db, orgA.orgId, async (tx) => {
        const merged = await mergeInTx(
          tx,
          { orgId: orgA.orgId, userId, role: 'owner' },
          p.target.id,
          p.source.id,
        );
        expect(merged.kind).toBe('merged');
        const holder = await backendPid(tx);
        // The merge has not committed, so the inbound still finds the source as a live contact.
        pending = inbound(orgA, p.sourcePhone, 'STOP', { providerMessageId, occurredAt: at(5) });
        const settle = () => {
          settled = true;
        };
        pending.then(settle, settle);
        await waitUntilBlockedBy(holder, () => settled);
      }),
    );
    await pending;

    const [row] = await messagesByProviderId(orgA, providerMessageId);
    expect(row).toMatchObject({ contactId: p.target.id, conversationId: p.targetConv.id });
    expect(await conversationsOf(orgA, p.source.id)).toHaveLength(0);
    expect((await smsPermission(orgA, p.target.id))?.status).toBe('opted_out');
    const sourceConsent = await tenant(orgA, (tx) =>
      tx
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, p.source.id)),
    );
    expect(sourceConsent).toHaveLength(0);
  });
});

describe('per-connection deliveries (cross-tenant guard)', () => {
  /** Ingests like `/webhooks/<provider>/<org>` does: stored for `signerOrgId`, then processed. */
  async function deliverAs(signerOrgId: string, body: string) {
    const spy = newSpy();
    const result = await ingestWebhook(
      spy.env,
      fake,
      new Headers({ 'x-fake-signature': await fake.signWebhook(body) }),
      new TextEncoder().encode(body),
      { organizationId: signerOrgId },
    );
    expect(result.status).toBe(200);
    const id = spy.sent[0];
    if (!id) throw new Error('not queued');
    const [msg] = await processIds([id]);
    expect(msg?.ack).toHaveBeenCalledTimes(1);
    const [raw] = await withAdminDb((db) =>
      db.select().from(providerEventRaw).where(eq(providerEventRaw.id, id)),
    );
    return raw;
  }

  const messagesOf = (orgId: string) =>
    withAdminDb((db) => db.select().from(message).where(eq(message.organizationId, orgId)));

  it('never applies a message verified with one workspace’s key to another workspace', async () => {
    const victim = await setupOrg('guard-msg-victim');
    const signer = await setupOrg('guard-msg-signer');
    const raw = await deliverAs(signer.orgId, inboundBody(victim, nextPhone(), 'not yours'));
    expect(raw).toMatchObject({ status: 'ignored', organizationId: signer.orgId });
    expect(await messagesOf(victim.orgId)).toEqual([]);
  });

  it('applies it to the workspace that signed it', async () => {
    const own = await setupOrg('guard-msg-own');
    const raw = await deliverAs(own.orgId, inboundBody(own, nextPhone(), 'mine'));
    expect(raw?.status).toBe('processed');
    expect(await messagesOf(own.orgId)).toHaveLength(1);
  });
});

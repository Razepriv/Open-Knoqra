import { env } from 'cloudflare:workers';
import {
  channelConnection,
  contact,
  contactPermissionEvent,
  ledgerEntry,
  message,
  messageTemplate,
  withTenant,
} from '@knoqra/db';
import {
  type AuthorizedWhatsAppRequest,
  type MessageFailure,
  type MessagingProvider,
  TelnyxMessagingError,
} from '@knoqra/providers';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { sendMessage } from '../src/messaging/send';
import { recordProviderResult } from '../src/messaging/store';
import { credit, ensureWallet } from '../src/services/ledger';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

/**
 * Test-only: these tests exercise failure recording, not the live gate (telnyx-messaging.test.ts
 * covers the credential, flag and PROVIDER gate), so they mark a `telnyx` sender live by wrapping
 * `senderFor` (the send path) and `toSender` (the composer builds its senders with it). Production
 * gating is unchanged; the provider itself is always the stub injected through
 * `SendDeps.provider`.
 */
vi.mock('../src/messaging/senders', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/messaging/senders')>();
  return {
    ...mod,
    senderFor: async (...args: Parameters<typeof mod.senderFor>) => {
      const sender = await mod.senderFor(...args);
      return sender?.provider === 'telnyx' ? { ...sender, liveEnabled: true } : sender;
    },
    toSender: (...args: Parameters<typeof mod.toSender>) => {
      const sender = mod.toSender(...args);
      return sender.provider === 'telnyx' ? { ...sender, liveEnabled: true } : sender;
    },
  };
});

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

interface Org {
  cookie: string;
  orgId: string;
  userId: string;
}

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

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    user: { id: string };
    organization: { id: string };
  }>;
  if (!me.data) throw new Error('no active organization');
  return { cookie, orgId: me.data.organization.id, userId: me.data.user.id };
}

/** An org on the fake sandbox senders, both approved. */
async function sandboxOrg(label: string): Promise<Org> {
  const org = await newOrg(label);
  const r = await put('/api/v1/messaging/sandbox', org.cookie, {
    sms: 'approved',
    whatsapp: 'approved',
  });
  expect(r.status).toBe(200);
  return org;
}

/** An org whose WhatsApp sender is an approved `telnyx` connection. */
async function telnyxWhatsAppOrg(label: string): Promise<Org> {
  const org = await newOrg(label);
  await withAppDb((db) =>
    withTenant(db, org.orgId, (tx) =>
      tx.insert(channelConnection).values({
        organizationId: org.orgId,
        channel: 'whatsapp',
        provider: 'telnyx',
        address: '+12025550199',
        registrationStatus: 'approved',
      }),
    ),
  );
  await fundWallet(org);
  return org;
}

/** Credit on M2's wallet: a Telnyx sender gets no development starter credit, and sends cost. */
function fundWallet(org: Org) {
  return withAppDb((db) =>
    withTenant(db, org.orgId, async (tx) => {
      await ensureWallet(tx, org.orgId, { starterCredit: false });
      await credit(tx, {
        orgId: org.orgId,
        amountMicros: 10_000_000,
        note: 'Test: live messaging credit',
        idempotencyKey: 'test-send-live-failures-credit',
        actorUserId: null,
      });
    }),
  );
}

interface Thread {
  contactId: string;
  conversationId: string;
}

async function thread(
  org: Org,
  channel: 'sms' | 'whatsapp',
  name = 'Maya Okafor',
  company?: string,
): Promise<Thread> {
  const created = await post('/api/v1/contacts', org.cookie, {
    displayName: name,
    phone: nextPhone(org),
    ...(company ? { company } : {}),
  });
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
  return { contactId, conversationId };
}

const tenantOf = (org: Org) => ({ orgId: org.orgId, userId: org.userId, role: 'owner' });

/** A provider whose every send throws the given Telnyx error, after an optional side effect. */
function failingProvider(error: TelnyxMessagingError, before?: () => Promise<void>) {
  const calls: unknown[] = [];
  const fail = async (input: unknown): Promise<never> => {
    calls.push(input);
    if (before) await before();
    throw error;
  };
  const provider: MessagingProvider = { sendSms: fail, sendWhatsApp: fail };
  return { provider, calls };
}

/** Polls until a session in this database is blocked behind the holder's backend `pid`. */
async function waitForWaiterBehind(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const blocked = await withAdminDb(async (db) => {
      const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and ${pid}::int = any(pg_blocking_pids(pid))`);
      return Number((result.rows[0] as { n: number }).n);
    });
    if (blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('no session blocked behind the lock holder');
}

/** An SMS provider that accepts every send. */
const acceptingProvider: MessagingProvider = {
  async sendSms() {
    return { providerMessageId: `telnyx_${crypto.randomUUID()}`, state: 'queued' };
  },
  async sendWhatsApp() {
    throw new Error('unexpected WhatsApp send');
  },
};

function recordingProvider() {
  const calls: AuthorizedWhatsAppRequest[] = [];
  const provider: MessagingProvider = {
    async sendSms() {
      throw new Error('unexpected SMS send');
    },
    async sendWhatsApp(input) {
      calls.push(input);
      return { providerMessageId: `telnyx_${crypto.randomUUID()}`, state: 'queued' };
    },
  };
  return { provider, calls };
}

async function sendWith(
  org: Org,
  provider: MessagingProvider,
  conversationId: string,
  input: { body: string } | { templateId: string },
) {
  return withAppDb((db) =>
    sendMessage({ db, env, tenant: tenantOf(org), provider }, conversationId, {
      clientMessageId: crypto.randomUUID(),
      ...input,
    }),
  );
}

async function composerOf(org: Org, conversationId: string) {
  const r = await get(`/api/v1/conversations/${conversationId}`, org.cookie);
  return ((await r.json()) as Envelope<{ composer: { mode: string; reason: string } }>).data
    ?.composer;
}

async function timelineTitles(org: Org, contactId: string) {
  const r = await get(`/api/v1/contacts/${contactId}/timeline`, org.cookie);
  const body = (await r.json()) as Envelope<{ items: Array<{ title: string }> }>;
  return body.data?.items.map((i) => i.title) ?? [];
}

const permissionEvents = (org: Org, contactId: string) =>
  withAppDb((db) =>
    withTenant(db, org.orgId, (tx) =>
      tx
        .select()
        .from(contactPermissionEvent)
        .where(eq(contactPermissionEvent.contactId, contactId)),
    ),
  );

/** The message ledger rows of the org (refType 'message'), or of one message. */
const messageLedger = (org: Org, messageId?: string) =>
  withAppDb((db) =>
    withTenant(db, org.orgId, (tx) =>
      tx
        .select()
        .from(ledgerEntry)
        .where(
          and(
            eq(ledgerEntry.refType, 'message'),
            ...(messageId === undefined ? [] : [eq(ledgerEntry.refId, messageId)]),
          ),
        ),
    ),
  );

/** A refused send holds the rate, then releases it in full: the wallet is charged nothing. */
async function expectReservedThenReleased(org: Org, messageId: string) {
  const entries = await messageLedger(org, messageId);
  expect(entries.map((e) => e.kind).sort()).toEqual(['release', 'reserve']);
  const hold = entries.find((e) => e.kind === 'reserve');
  const release = entries.find((e) => e.kind === 'release');
  expect(release).toMatchObject({
    reservationId: hold?.id,
    balanceDeltaMicros: 0,
    heldDeltaMicros: -(hold?.heldDeltaMicros ?? 0),
    idempotencyKey: `message:${messageId}:release`,
  });
  expect(entries.reduce((sum, e) => sum + e.balanceDeltaMicros, 0)).toBe(0);
  expect(entries.reduce((sum, e) => sum + e.heldDeltaMicros, 0)).toBe(0);
}

async function createTemplate(org: Org, channel: 'sms' | 'whatsapp', body: string, meta = {}) {
  const r = await post('/api/v1/messaging/templates', org.cookie, {
    name: `Tpl ${crypto.randomUUID().slice(0, 8)}`,
    channel,
    body,
    ...meta,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as Envelope<{ id: string }>).data as { id: string };
}

/** Meta approval happens outside KNOQRA; the test stands in for it. */
const approve = (templateId: string) =>
  withAdminDb((db) =>
    db
      .update(messageTemplate)
      .set({ approvalStatus: 'approved' })
      .where(eq(messageTemplate.id, templateId)),
  );

let sandbox: Org;

beforeAll(async () => {
  sandbox = await sandboxOrg('live-fail');
});

const CASES: Array<[MessageFailure['code'], number, string]> = [
  ['opted_out', 403, '40300'],
  ['invalid_number', 400, '40012'],
  ['provider_auth', 401, '10009'],
  ['provider_rejected', 422, '10015'],
  ['provider_rate_limited', 429, '10011'],
  ['provider_error', 500, '10007'],
];

describe('telnyx send failures', () => {
  it.each(CASES)('records %s as a failed message', async (code, status, telnyxCode) => {
    const t = await thread(sandbox, 'sms');
    const error = new TelnyxMessagingError(status, telnyxCode);
    const { provider, calls } = failingProvider(error);
    const result = await sendWith(sandbox, provider, t.conversationId, { body: 'Hello' });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(calls).toHaveLength(1);
    expect(result.message.status).toBe('failed');
    expect(result.message.error).toEqual({ code, message: error.failure.message });
    expect(result.message.providerMessageId).toBeNull();
    // Every refusal releases its hold; opted_out (40300) and provider_auth (401) included.
    await expectReservedThenReleased(sandbox, result.message.id);
  });

  it('keeps provider_error for any other throw', async () => {
    const t = await thread(sandbox, 'sms');
    const provider: MessagingProvider = {
      async sendSms() {
        throw new Error('socket hang up');
      },
      async sendWhatsApp() {
        throw new Error('socket hang up');
      },
    };
    const result = await sendWith(sandbox, provider, t.conversationId, { body: 'Hello' });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.error).toEqual({
      code: 'provider_error',
      message: 'The provider did not accept the message.',
    });
    expect(await permissionEvents(sandbox, t.contactId)).toHaveLength(1);
  });

  it('records an SMS opt-out reported by Telnyx, after which the composer is blocked', async () => {
    const t = await thread(sandbox, 'sms');
    expect(await composerOf(sandbox, t.conversationId)).toMatchObject({ mode: 'free' });
    const { provider } = failingProvider(new TelnyxMessagingError(403, '40300'));
    const result = await sendWith(sandbox, provider, t.conversationId, { body: 'Hello' });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.error?.code).toBe('opted_out');

    const events = await permissionEvents(sandbox, t.contactId);
    const latest = events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(latest).toMatchObject({
      channel: 'sms',
      status: 'opted_out',
      source: 'system',
      evidence: 'The phone provider reported an opt-out',
      actorUserId: null,
    });
    expect(await composerOf(sandbox, t.conversationId)).toEqual({
      mode: 'blocked',
      reason: 'opted_out',
      windowExpiresAt: null,
    });
    expect(await timelineTitles(sandbox, t.contactId)).toContain(
      'SMS opted out (reported by the phone provider)',
    );
  });

  it('records a WhatsApp opt-out on the WhatsApp channel only', async () => {
    const t = await thread(sandbox, 'whatsapp');
    const tpl = await createTemplate(sandbox, 'whatsapp', 'Hi {{first_name}}');
    const { provider } = failingProvider(new TelnyxMessagingError(403, '40300'));
    const result = await sendWith(sandbox, provider, t.conversationId, { templateId: tpl.id });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.error?.code).toBe('opted_out');
    const optOuts = (await permissionEvents(sandbox, t.contactId)).filter(
      (e) => e.status === 'opted_out',
    );
    expect(optOuts.map((e) => e.channel)).toEqual(['whatsapp']);
    expect(await timelineTitles(sandbox, t.contactId)).toContain(
      'WhatsApp opted out (reported by the phone provider)',
    );
  });

  it('records an opt-out once when the same failure is recorded twice', async () => {
    const t = await thread(sandbox, 'sms');
    const error = new TelnyxMessagingError(403, '40300');
    const { provider } = failingProvider(error);
    const result = await sendWith(sandbox, provider, t.conversationId, { body: 'Hello' });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    // A retried write of the same provider result: failed -> failed is ignored, and so is the opt-out.
    await withAppDb((db) =>
      withTenant(db, sandbox.orgId, (tx) =>
        recordProviderResult(tx, result.message.id, { ok: false, failure: error.failure }),
      ),
    );
    const optOuts = (await permissionEvents(sandbox, t.contactId)).filter(
      (e) => e.status === 'opted_out',
    );
    expect(optOuts).toHaveLength(1);
    const titles = await timelineTitles(sandbox, t.contactId);
    expect(
      titles.filter((title) => title === 'SMS opted out (reported by the phone provider)'),
    ).toHaveLength(1);
  });

  it('locks the contact before the message when recording a reported opt-out', async () => {
    const t = await thread(sandbox, 'sms');
    const sent = await sendWith(sandbox, acceptingProvider, t.conversationId, { body: 'Hello' });
    if (sent.kind !== 'created') throw new Error(`unexpected ${sent.kind}`);
    const messageId = sent.message.id;
    const failure = new TelnyxMessagingError(403, '40300').failure;
    let recording: Promise<void> = Promise.resolve();
    // Hold the contact; the opt-out recorder must queue behind it before touching the message,
    // so the holder can still take the message lock without waiting.
    try {
      await withAdminDb((db) =>
        db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local lock_timeout = '15s'`));
          const [{ pid } = { pid: 0 }] = (
            await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`)
          ).rows;
          await tx.select().from(contact).where(eq(contact.id, t.contactId)).for('update');
          recording = withAppDb((app) =>
            withTenant(app, sandbox.orgId, (rtx) =>
              recordProviderResult(rtx, messageId, { ok: false, failure }),
            ),
          );
          await waitForWaiterBehind(pid);
          // Throws "could not obtain lock" if the recorder took the message lock first.
          const free = await tx
            .select({ id: message.id })
            .from(message)
            .where(eq(message.id, messageId))
            .for('update', { noWait: true });
          expect(free).toHaveLength(1);
        }),
      );
    } catch (error) {
      // The holder rolled back, so the recorder finishes; do not leak its outcome.
      await Promise.allSettled([recording]);
      throw error;
    }
    await recording;
    const optOuts = (await permissionEvents(sandbox, t.contactId)).filter(
      (e) => e.status === 'opted_out',
    );
    expect(optOuts).toHaveLength(1);
    await expectReservedThenReleased(sandbox, messageId);
  });

  it('keeps do_not_contact when Telnyx reports an opt-out', async () => {
    const t = await thread(sandbox, 'sms');
    // The contact is marked Do not contact while the send is in flight.
    const { provider } = failingProvider(new TelnyxMessagingError(403, '40300'), async () => {
      const r = await post(`/api/v1/contacts/${t.contactId}/do-not-contact`, sandbox.cookie, {});
      expect(r.status).toBe(200);
    });
    const result = await sendWith(sandbox, provider, t.conversationId, { body: 'Hello' });
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.error?.code).toBe('opted_out');
    const events = await permissionEvents(sandbox, t.contactId);
    expect(events.some((e) => e.status === 'opted_out')).toBe(false);
    expect(await composerOf(sandbox, t.conversationId)).toMatchObject({
      mode: 'blocked',
      reason: 'do_not_contact',
    });
    expect(await timelineTitles(sandbox, t.contactId)).not.toContain(
      'SMS opted out (reported by the phone provider)',
    );
  });
});

describe('WhatsApp templates through a telnyx sender', () => {
  let org: Org;

  beforeAll(async () => {
    org = await telnyxWhatsAppOrg('live-wa');
  });

  it('refuses a template without Meta fields with 422, no provider call and no ledger row', async () => {
    const t = await thread(org, 'whatsapp');
    const before = await messageLedger(org);
    // Created before the sender was telnyx, so it has no Meta fields.
    const [row] = await withAppDb((db) =>
      withTenant(db, org.orgId, (tx) =>
        tx
          .insert(messageTemplate)
          .values({
            organizationId: org.orgId,
            name: 'Legacy',
            channel: 'whatsapp',
            body: 'Hi {{first_name}}',
            approvalStatus: 'approved',
          })
          .returning(),
      ),
    );
    const { provider, calls } = recordingProvider();
    const result = await sendWith(org, provider, t.conversationId, {
      templateId: row?.id as string,
    });
    expect(result).toEqual({
      kind: 'error',
      status: 422,
      code: 'validation_error',
      message: 'Live WhatsApp templates need the Meta template name and language.',
    });
    expect(calls).toHaveLength(0);
    // Refused before the hold: no reserve (and so nothing to release).
    expect(await messageLedger(org)).toHaveLength(before.length);
  });

  it('sends the Meta template name, language and parameters', async () => {
    const t = await thread(org, 'whatsapp');
    const tpl = await createTemplate(org, 'whatsapp', 'Hi {{first_name}}', {
      whatsappTemplateName: 'table_ready',
      whatsappLanguage: 'en_US',
    });
    await approve(tpl.id);
    const { provider, calls } = recordingProvider();
    const result = await sendWith(org, provider, t.conversationId, { templateId: tpl.id });
    if (result.kind !== 'created') throw new Error(`unexpected ${JSON.stringify(result)}`);
    expect(result.message).toMatchObject({ body: 'Hi Maya', status: 'queued' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.template).toEqual({
      name: 'table_ready',
      language: 'en_US',
      parameters: ['Maya'],
    });
  });

  it('orders parameters by first appearance, once each', async () => {
    const t = await thread(org, 'whatsapp', 'Maya Okafor', 'Acme');
    const tpl = await createTemplate(
      org,
      'whatsapp',
      '{{company}}: hi {{first_name}}, {{company}} has your table, {{name}}',
      { whatsappTemplateName: 'table_ready_2', whatsappLanguage: 'en' },
    );
    await approve(tpl.id);
    const { provider, calls } = recordingProvider();
    const result = await sendWith(org, provider, t.conversationId, { templateId: tpl.id });
    if (result.kind !== 'created') throw new Error(`unexpected ${JSON.stringify(result)}`);
    expect(calls[0]?.template?.parameters).toEqual(['Acme', 'Maya', 'Maya Okafor']);
  });
});

import { env } from 'cloudflare:workers';
import type { TenDlcState } from '@knoqra/core';
import {
  auditEvent,
  channelConnection,
  channelRoute,
  messageTemplate,
  type NewPhoneNumber,
  type PhoneNumberRow,
  phoneNumber,
  providerCredential,
  providerNumberRoute,
  withTenant,
} from '@knoqra/db';
import type { NumbersProvider } from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { resolveRoute } from '../src/messaging/routing';
import { liveEnabled, refreshTelnyxSenders } from '../src/messaging/senders';
import { syncNumbers } from '../src/services/numbers';
import { sendableFor, smsRegistration } from '../src/services/sender-registration';
import {
  api,
  get,
  phoneNumbersFetch,
  saveTelnyxCredential,
  seedSyncedNumber,
  sendersRequest,
  signUp,
  signUpTeammate,
  TEST_TELNYX_API_KEY,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Sender = {
  id: string;
  channel: string;
  provider: string;
  address: string;
  registrationStatus: string;
  sandbox: boolean;
  liveEnabled: boolean;
};

const executionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let cookieA: string;
let cookieB: string;
let orgA: string;

async function put(
  path: string,
  cookie: string,
  body: unknown,
  envOverride?: Env,
): Promise<Response> {
  const init = {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  };
  return envOverride ? app.request(path, init, envOverride, executionContext) : api(path, init);
}

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

const bySms = (items: Sender[], channel: string) => items.find((s) => s.channel === channel);

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('snd-a'), 'Owner A');
  cookieB = await signUp(uniqueEmail('snd-b'), 'Owner B');
  orgA = await orgOf(cookieA);
});

describe('messaging senders and sandbox', () => {
  it('lists no senders on a fresh org and reports the sandbox as available', async () => {
    const r = await get('/api/v1/messaging/senders', cookieB);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Envelope<{ items: Sender[]; sandboxAvailable: boolean }>;
    expect(body.data).toEqual({ items: [], sandboxAvailable: true, liveAvailable: false });
  });

  it('creates both sandbox senders, then keeps the addresses and changes statuses', async () => {
    const first = await put('/api/v1/messaging/sandbox', cookieA, {
      sms: 'approved',
      whatsapp: 'pending',
    });
    expect(first.status).toBe(200);
    const { items } = ((await first.json()) as Envelope<{ items: Sender[] }>).data ?? {
      items: [],
    };
    expect(items).toHaveLength(2);
    const sms = bySms(items, 'sms');
    const wa = bySms(items, 'whatsapp');
    expect(sms).toMatchObject({
      provider: 'fake',
      registrationStatus: 'approved',
      sandbox: true,
      liveEnabled: true,
    });
    expect(wa).toMatchObject({ registrationStatus: 'pending', sandbox: true, liveEnabled: true });
    expect(sms?.address).toMatch(/^sandbox:[0-9a-f]{24}$/);
    expect(wa?.address).toMatch(/^sandbox:[0-9a-f]{24}$/);

    const second = await put('/api/v1/messaging/sandbox', cookieA, {
      sms: 'rejected',
      whatsapp: 'approved',
    });
    const again = ((await second.json()) as Envelope<{ items: Sender[] }>).data?.items ?? [];
    expect(bySms(again, 'sms')).toMatchObject({
      address: sms?.address,
      registrationStatus: 'rejected',
    });
    expect(bySms(again, 'whatsapp')).toMatchObject({
      address: wa?.address,
      registrationStatus: 'approved',
    });

    const listed = (
      (await (await get('/api/v1/messaging/senders', cookieA)).json()) as Envelope<{
        items: Sender[];
      }>
    ).data?.items;
    expect(listed).toHaveLength(2);

    const routes = await withAppDb((db) =>
      withTenant(db, orgA, (tx) => tx.select().from(channelRoute)),
    );
    expect(routes.filter((r) => r.organizationId === orgA)).toHaveLength(2);
    const audits = await withAppDb((db) =>
      withTenant(db, orgA, (tx) => tx.select().from(auditEvent)),
    );
    expect(audits.filter((a) => a.action === 'sandbox.update')).toHaveLength(2);
  });

  it('404s the sandbox in production', async () => {
    const productionEnv = { ...env, APP_ENV: 'production' } as unknown as Env;
    const r = await put(
      '/api/v1/messaging/sandbox',
      cookieA,
      { sms: 'approved', whatsapp: 'approved' },
      productionEnv,
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
  });

  it('refuses a sandbox over an existing live sender', async () => {
    const cookie = await signUp(uniqueEmail('snd-live'), 'Owner Live');
    const org = await orgOf(cookie);
    await withAppDb((db) =>
      withTenant(db, org, (tx) =>
        tx.insert(channelConnection).values({
          organizationId: org,
          channel: 'sms',
          provider: 'telnyx',
          address: '+12025550142',
          registrationStatus: 'approved',
        }),
      ),
    );
    const r = await put('/api/v1/messaging/sandbox', cookie, {
      sms: 'approved',
      whatsapp: 'approved',
    });
    expect(r.status).toBe(422);
    const body = (await r.json()) as Envelope<unknown>;
    expect(body.error).toEqual({
      code: 'validation_error',
      message: 'This channel already has a live sender.',
    });
  });

  it('a live WhatsApp conflict rolls back the SMS change made before it', async () => {
    const cookie = await signUp(uniqueEmail('snd-roll'), 'Owner Roll');
    const org = await orgOf(cookie);
    // A pending SMS sandbox sender and a live WhatsApp sender. The PUT updates SMS first, then
    // meets the live WhatsApp sender.
    await withAppDb((db) =>
      withTenant(db, org, (tx) =>
        tx.insert(channelConnection).values([
          {
            organizationId: org,
            channel: 'sms',
            provider: 'fake',
            address: `sandbox:${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
            registrationStatus: 'pending',
          },
          {
            organizationId: org,
            channel: 'whatsapp',
            provider: 'telnyx',
            address: '+12025550143',
            registrationStatus: 'approved',
          },
        ]),
      ),
    );
    const r = await put('/api/v1/messaging/sandbox', cookie, {
      sms: 'approved',
      whatsapp: 'approved',
    });
    expect(r.status).toBe(422);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'This channel already has a live sender.',
    });
    const [sms] = await withAppDb((db) =>
      withTenant(db, org, (tx) =>
        tx
          .select()
          .from(channelConnection)
          .where(
            and(eq(channelConnection.organizationId, org), eq(channelConnection.channel, 'sms')),
          ),
      ),
    );
    expect(sms?.registrationStatus).toBe('pending');
    const audits = await withAppDb((db) =>
      withTenant(db, org, (tx) =>
        tx.select().from(auditEvent).where(eq(auditEvent.action, 'sandbox.update')),
      ),
    );
    expect(audits.map((a) => a.outcome)).toEqual(['denied']);
    expect(audits[0]?.metadata).toEqual({
      reason: 'live_sender',
      channel: 'whatsapp',
    });
  });

  it('computes liveEnabled from provider, PROVIDER and the credential, ignoring the retired flags', () => {
    const base = env as unknown as Env;
    expect(liveEnabled('fake', 'sms', base, false)).toBe(true);
    expect(
      liveEnabled('fake', 'sms', { ...base, FAKE_WEBHOOK_SECRET: undefined } as Env, false),
    ).toBe(false);
    expect(liveEnabled('fake', 'sms', { ...base, APP_ENV: 'production' } as Env, false)).toBe(
      false,
    );
    const live = { ...base, PROVIDER: 'telnyx' } as Env;
    expect(liveEnabled('telnyx', 'sms', live, true)).toBe(true);
    expect(liveEnabled('telnyx', 'whatsapp', live, true)).toBe(true);
    // The per-workspace registration status gates sending now, not these flags.
    expect(
      liveEnabled('telnyx', 'sms', { ...live, SMS_10DLC_APPROVED: 'false' } as Env, true),
    ).toBe(true);
    expect(liveEnabled('telnyx', 'sms', live, false)).toBe(false);
    expect(liveEnabled('telnyx', 'sms', { ...live, PROVIDER: 'fake' } as Env, true)).toBe(false);
  });
});

/** Sender numbers used only by this file; their telnyx routes are cleared before the run. */
const LIVE_NUMBERS = Array.from({ length: 22 }, (_, i) => `+12025550${170 + i}`);
const num = (i: number) => LIVE_NUMBERS[i] as string;

/** Telnyx selected for this deployment: the senders route only works there (ruling AI). */
const telnyxEnv = { ...env, PROVIDER: 'telnyx' } as unknown as Env;

describe('PUT /api/v1/messaging/senders/{channel}', () => {
  /** Every number of this file is in the org's Telnyx account unless a test says otherwise. */
  const owningAll = () => phoneNumbersFetch(LIVE_NUMBERS);

  const putSender = (
    cookie: string,
    channel: string,
    body: unknown,
    telnyx: { impl: typeof fetch; calls: string[] } = owningAll(),
    bindings: Env = telnyxEnv,
  ) =>
    sendersRequest(telnyx.impl, bindings, `/api/v1/messaging/senders/${channel}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  const listSendersOf = async (cookie: string, bindings: Env = telnyxEnv) => {
    const r = await sendersRequest(owningAll().impl, bindings, '/api/v1/messaging/senders', {
      headers: { cookie },
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as Envelope<{ items: Sender[]; liveAvailable: boolean }>).data;
  };

  const routesOf = (orgId: string) =>
    withAdminDb((db) =>
      db
        .select()
        .from(channelRoute)
        .where(and(eq(channelRoute.organizationId, orgId), eq(channelRoute.provider, 'telnyx'))),
    );

  const connectionsOf = (orgId: string) =>
    withAppDb((db) => withTenant(db, orgId, (tx) => tx.select().from(channelConnection)));

  const auditsOf = (orgId: string, outcome: string) =>
    withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgId),
            eq(auditEvent.action, 'sender.update'),
            eq(auditEvent.outcome, outcome as 'allowed'),
          ),
        )
        .orderBy(auditEvent.createdAt),
    );

  const errorOf = async (r: Response) => ((await r.json()) as Envelope<unknown>).error;
  const itemsOf = async (r: Response) =>
    ((await r.json()) as Envelope<{ items: Sender[] }>).data?.items ?? [];

  /**
   * An owner whose Telnyx credential is saved and whose numbers M4 synced. By default the caller
   * id is synced as an active, registered number.
   */
  async function ownerWithCredential(
    label: string,
    callerId: string | null,
    synced: readonly string[] = callerId ? [callerId] : [],
  ) {
    const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
    const orgId = await orgOf(cookie);
    await saveTelnyxCredential(orgId, callerId);
    for (const e164 of synced) await seedSyncedNumber(orgId, e164);
    return { cookie, orgId };
  }

  const setSynced = (orgId: string, e164: string, set: Partial<NewPhoneNumber>) =>
    withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx.update(phoneNumber).set(set).where(eq(phoneNumber.e164, e164)),
      ),
    );

  /** Telnyx's numbers as the sync reads them (no network). */
  const listing = (rows: Array<{ e164: string; tenDlc?: TenDlcState }>): NumbersProvider => ({
    listNumbers: async () =>
      rows.map((r) => ({
        providerNumberId: `tn-${r.e164.slice(1)}`,
        e164: r.e164,
        status: 'active' as const,
        capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
        tenDlc: r.tenDlc ?? 'registered',
        whatsapp: 'none' as const,
      })),
  });

  const syncAs = (orgId: string, provider: 'fake' | 'telnyx', numbers: NumbersProvider) =>
    withAppDb((db) =>
      withTenant(db, orgId, (tx) => syncNumbers(tx, orgId, provider, numbers, new Date())),
    );

  beforeAll(async () => {
    await withAdminDb(async (db) => {
      await db
        .delete(channelRoute)
        .where(
          and(eq(channelRoute.provider, 'telnyx'), inArray(channelRoute.address, LIVE_NUMBERS)),
        );
      await db
        .delete(providerNumberRoute)
        .where(
          and(
            eq(providerNumberRoute.provider, 'telnyx'),
            inArray(providerNumberRoute.e164, LIVE_NUMBERS),
          ),
        );
    });
  });

  it('answers 403 for a member and audits the refusal', async () => {
    const { orgId } = await ownerWithCredential('snd-role', num(0));
    const mate = await signUpTeammate(orgId);
    const telnyx = owningAll();
    const r = await putSender(mate.cookie, 'sms', {}, telnyx);
    expect(r.status).toBe(403);
    expect((await errorOf(r))?.code).toBe('forbidden');
    expect(telnyx.calls).toEqual([]);
    expect(await routesOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'role', channel: 'sms' },
    ]);
  });

  it('answers 422 off a Telnyx deployment, audited, and lists liveAvailable false', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-fake', num(0));
    const fakeEnv = { ...env, PROVIDER: 'fake' } as unknown as Env;
    const telnyx = owningAll();
    const r = await putSender(cookie, 'sms', {}, telnyx, fakeEnv);
    expect(r.status).toBe(422);
    expect(await errorOf(r)).toEqual({
      code: 'not_configured',
      message: "Live sending isn't available on this deployment.",
    });
    expect(telnyx.calls).toEqual([]);
    expect(await connectionsOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'live_unavailable', channel: 'sms' },
    ]);
    expect((await listSendersOf(cookie, fakeEnv))?.liveAvailable).toBe(false);
    expect((await listSendersOf(cookie))?.liveAvailable).toBe(true);
  });

  it('answers 422 without a saved Telnyx credential', async () => {
    const r = await putSender(cookieB, 'sms', {});
    expect(r.status).toBe(422);
    expect((await errorOf(r))?.message).toBe('Connect your phone provider first.');
  });

  it('verifies the caller id, takes the status from the synced number, and routes it once', async () => {
    const number = num(1);
    const { cookie, orgId } = await ownerWithCredential('snd-live', number);
    await setSynced(orgId, number, { tenDlcStatus: 'pending' });

    // The synced 10DLC state decides for SMS: a status in the body is refused.
    const typed = owningAll();
    const refused = await putSender(cookie, 'sms', { registrationStatus: 'approved' }, typed);
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toEqual({
      code: 'validation_error',
      message: 'registrationStatus: The status comes from your synced numbers.',
    });
    expect(typed.calls).toEqual([]);
    expect(await connectionsOf(orgId)).toEqual([]);

    const telnyx = owningAll();
    const first = await putSender(cookie, 'sms', {}, telnyx);
    expect(first.status).toBe(200);
    expect(telnyx.calls).toEqual(['/v2/phone_numbers']);
    const sms = bySms(await itemsOf(first), 'sms');
    expect(sms).toMatchObject({
      provider: 'telnyx',
      address: number,
      registrationStatus: 'pending',
      sandbox: false,
      // Live on a Telnyx deployment with a credential; the pending status pauses the composer.
      liveEnabled: true,
    });

    await setSynced(orgId, number, { tenDlcStatus: 'registered' });
    const second = await putSender(cookie, 'sms', {});
    expect(second.status).toBe(200);
    const routes = await routesOf(orgId);
    expect(routes.map((r) => [r.channel, r.address])).toEqual([['sms', number]]);
    expect(routes[0]?.connectionId).toBe(sms?.id);
    const [row] = await connectionsOf(orgId);
    // Same address: the connection is updated in place, not replaced.
    expect(row).toMatchObject({ id: sms?.id, registrationStatus: 'approved' });
    expect((await auditsOf(orgId, 'allowed')).map((a) => a.metadata)).toEqual([
      { channel: 'sms', registrationStatus: 'pending' },
      { channel: 'sms', registrationStatus: 'approved' },
    ]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'status_synced', channel: 'sms' },
    ]);
  });

  it('sets a WhatsApp sender with the status Meta gave the synced number', async () => {
    const number = num(8);
    const { cookie, orgId } = await ownerWithCredential('snd-wa', number, []);
    await seedSyncedNumber(orgId, number, { whatsapp: true, whatsappStatus: 'pending' });

    // The status comes from the sync: a status in the body is refused.
    const typed = owningAll();
    const refused = await putSender(cookie, 'whatsapp', { registrationStatus: 'approved' }, typed);
    expect(refused.status).toBe(400);
    expect(typed.calls).toEqual([]);

    const telnyx = owningAll();
    const pending = await putSender(cookie, 'whatsapp', {}, telnyx);
    expect(pending.status).toBe(200);
    // Ownership is still checked live with the org's key.
    expect(telnyx.calls).toEqual(['/v2/phone_numbers']);
    const sender = bySms(await itemsOf(pending), 'whatsapp');
    expect(sender).toMatchObject({
      provider: 'telnyx',
      address: number,
      registrationStatus: 'pending',
    });

    await setSynced(orgId, number, { whatsappStatus: 'approved' });
    const approved = await putSender(cookie, 'whatsapp', {});
    expect(approved.status).toBe(200);
    const [row] = await connectionsOf(orgId);
    expect(row).toMatchObject({ id: sender?.id, registrationStatus: 'approved' });
    expect((await resolveWith('whatsapp', number))?.orgId).toBe(orgId);
  });

  it('refuses a WhatsApp sender on a number Telnyx does not list for WhatsApp', async () => {
    const number = num(7);
    const { cookie, orgId } = await ownerWithCredential('snd-wa-none', number, []);
    await seedSyncedNumber(orgId, number, { whatsapp: false, whatsappStatus: 'none' });
    const telnyx = owningAll();
    const r = await putSender(cookie, 'whatsapp', {}, telnyx);
    expect(r.status).toBe(422);
    expect((await errorOf(r))?.code).toBe('number_not_synced');
    expect(telnyx.calls).toEqual([]);
  });

  it('still refuses a WhatsApp number that is not in the Telnyx account', async () => {
    const number = num(9);
    const { cookie, orgId } = await ownerWithCredential('snd-wa-notown', number, []);
    await seedSyncedNumber(orgId, number, { whatsapp: true });
    const r = await putSender(cookie, 'whatsapp', {}, phoneNumbersFetch([]));
    expect(r.status).toBe(422);
    expect((await errorOf(r))?.code).toBe('number_not_owned');
    expect(await connectionsOf(orgId)).toEqual([]);
  });

  it('needs an address when the credential has no caller id, and checks it is E.164', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-addr', null, [num(2)]);
    await setSynced(orgId, num(2), { whatsappStatus: 'none' });
    const missing = await putSender(cookie, 'whatsapp', {});
    expect(missing.status).toBe(400);
    const bad = await putSender(cookie, 'whatsapp', { address: 'not a number' });
    expect(bad.status).toBe(400);
    const good = await putSender(cookie, 'whatsapp', { address: '(202) 555-0172' });
    expect(good.status).toBe(200);
    expect(bySms(await itemsOf(good), 'whatsapp')?.registrationStatus).toBe('not_started');
    expect((await routesOf(orgId)).map((r) => [r.channel, r.address])).toEqual([
      ['whatsapp', num(2)],
    ]);
  });

  it('replaces a sandbox sender on that channel', async () => {
    const cookie = await signUp(uniqueEmail('snd-swap'), 'Owner Swap');
    const orgId = await orgOf(cookie);
    expect(
      (await put('/api/v1/messaging/sandbox', cookie, { sms: 'approved', whatsapp: 'approved' }))
        .status,
    ).toBe(200);
    await saveTelnyxCredential(orgId, num(3));
    await seedSyncedNumber(orgId, num(3));
    const r = await putSender(cookie, 'sms', {});
    expect(r.status).toBe(200);
    const items = await itemsOf(r);
    expect(items.map((s) => [s.channel, s.provider])).toEqual([
      ['sms', 'telnyx'],
      ['whatsapp', 'fake'],
    ]);
    const routes = await withAdminDb((db) =>
      db.select().from(channelRoute).where(eq(channelRoute.organizationId, orgId)),
    );
    expect(routes.map((x) => [x.channel, x.provider]).sort()).toEqual([
      ['sms', 'telnyx'],
      ['whatsapp', 'fake'],
    ]);
  });

  it('resets approved WhatsApp templates to pending when a live sender replaces the sandbox (ruling AT)', async () => {
    const cookie = await signUp(uniqueEmail('snd-tpl'), 'Owner Templates');
    const orgId = await orgOf(cookie);
    expect(
      (await put('/api/v1/messaging/sandbox', cookie, { sms: 'approved', whatsapp: 'approved' }))
        .status,
    ).toBe(200);
    const template = (
      name: string,
      channel: 'sms' | 'whatsapp',
      approvalStatus: 'approved' | 'pending',
      archived = false,
    ) => ({
      organizationId: orgId,
      name,
      channel,
      body: 'Hi {{first_name}}',
      approvalStatus,
      ...(archived ? { archivedAt: new Date() } : {}),
    });
    const rows = await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx
          .insert(messageTemplate)
          .values([
            template('Sandbox approved', 'whatsapp', 'approved'),
            template('Archived approved', 'whatsapp', 'approved', true),
            template('Already pending', 'whatsapp', 'pending'),
            template('SMS approved', 'sms', 'approved'),
          ])
          .returning({ id: messageTemplate.id, name: messageTemplate.name }),
      ),
    );
    const idOf = (name: string) => rows.find((r) => r.name === name)?.id as string;
    const statuses = async () =>
      Object.fromEntries(
        (
          await withAppDb((db) =>
            withTenant(db, orgId, (tx) =>
              tx
                .select({ name: messageTemplate.name, status: messageTemplate.approvalStatus })
                .from(messageTemplate),
            ),
          )
        ).map((r) => [r.name, r.status]),
      );
    await saveTelnyxCredential(orgId, num(20));
    await seedSyncedNumber(orgId, num(20));

    // A live SMS sender leaves WhatsApp templates alone.
    expect((await putSender(cookie, 'sms', {})).status).toBe(200);
    expect((await statuses())['Sandbox approved']).toBe('approved');

    const r = await putSender(cookie, 'whatsapp', {});
    expect(r.status).toBe(200);
    expect(await statuses()).toEqual({
      'Sandbox approved': 'pending',
      'Archived approved': 'approved',
      'Already pending': 'pending',
      'SMS approved': 'approved',
    });
    const resets = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgId),
            eq(auditEvent.action, 'template.reset_approval'),
          ),
        ),
    );
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({
      outcome: 'allowed',
      entityType: 'message_template',
      metadata: {
        reason: 'live_sender',
        channel: 'whatsapp',
        templateIds: [idOf('Sandbox approved')],
      },
    });

    // Re-saving the live sender (telnyx to telnyx) resets nothing again.
    await withAppDb((db) =>
      withTenant(db, orgId, (tx) =>
        tx
          .update(messageTemplate)
          .set({ approvalStatus: 'approved' })
          .where(eq(messageTemplate.id, idOf('Sandbox approved'))),
      ),
    );
    expect((await putSender(cookie, 'whatsapp', {})).status).toBe(200);
    expect((await statuses())['Sandbox approved']).toBe('approved');
  });

  it('refuses a number that is not an active synced number, without asking Telnyx', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-unsynced', num(10), []);
    const cases: Array<[string, Partial<NewPhoneNumber> | null]> = [
      ['never synced', null],
      ['pending', { status: 'pending' }],
      ['inactive', { status: 'inactive' }],
      ['a fake number', { provider: 'fake' }],
    ];
    for (const [label, row] of cases) {
      await withAppDb((db) =>
        withTenant(db, orgId, (tx) => tx.delete(phoneNumber).where(eq(phoneNumber.e164, num(10)))),
      );
      if (row) await seedSyncedNumber(orgId, num(10), row);
      const telnyx = owningAll();
      const r = await putSender(cookie, 'sms', {}, telnyx);
      expect(r.status, label).toBe(422);
      expect(await errorOf(r), label).toEqual({
        code: 'number_not_synced',
        message: 'Sync your numbers, then choose an active number.',
      });
      expect(telnyx.calls, label).toEqual([]);
    }
    expect(await connectionsOf(orgId)).toEqual([]);
    expect(await routesOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual(
      cases.map(() => ({ reason: 'not_synced', channel: 'sms' })),
    );
  });

  it('refuses a synced number that cannot send on the channel', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-capable', num(11), []);
    // No capability at all: neither channel.
    await seedSyncedNumber(orgId, num(11), {
      voice: false,
      sms: false,
      mms: false,
      whatsapp: false,
    });
    for (const channel of ['sms', 'whatsapp'] as const) {
      const body = {};
      const r = await putSender(cookie, channel, body);
      expect(r.status).toBe(422);
      expect(await errorOf(r)).toEqual({
        code: 'number_not_synced',
        message: "This number can't send on this channel yet.",
      });
    }
    expect(await connectionsOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'not_capable', channel: 'sms' },
      { reason: 'not_capable', channel: 'whatsapp' },
    ]);
  });

  it("refuses a number that isn't in the org's Telnyx account and writes nothing", async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-notown', null, [num(7)]);
    const telnyx = phoneNumbersFetch([]);
    const r = await putSender(cookie, 'sms', { address: num(7) }, telnyx);
    expect(r.status).toBe(422);
    expect(await errorOf(r)).toEqual({
      code: 'number_not_owned',
      message: "This number isn't in your phone provider account.",
    });
    expect(telnyx.calls).toEqual(['/v2/phone_numbers']);
    expect(await connectionsOf(orgId)).toEqual([]);
    expect(await routesOf(orgId)).toEqual([]);
    expect(await resolveWith('sms', num(7))).toBeNull();
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'not_owned', channel: 'sms' },
    ]);
  });

  it('answers 422 when Telnyx refuses the saved key, and writes nothing', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-401', num(7));
    const r = await putSender(cookie, 'sms', {}, phoneNumbersFetch(LIVE_NUMBERS, 401));
    expect(r.status).toBe(422);
    expect(await errorOf(r)).toEqual({
      code: 'provider_auth',
      message: 'Your phone provider did not accept the saved API key.',
    });
    expect(await connectionsOf(orgId)).toEqual([]);
    expect(await routesOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'provider_auth', channel: 'sms' },
    ]);
  });

  it('answers 502 with generic copy when Telnyx fails, and writes nothing', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-502', num(7));
    const r = await putSender(cookie, 'sms', {}, phoneNumbersFetch(LIVE_NUMBERS, 500));
    expect(r.status).toBe(502);
    expect(await errorOf(r)).toEqual({
      code: 'internal_error',
      message: 'Your phone provider could not be reached. Try again in a moment.',
    });
    expect(await connectionsOf(orgId)).toEqual([]);
  });

  it('answers 502 with generic copy when the ownership check times out', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-timeout', num(12));
    const calls: string[] = [];
    let signal: AbortSignal | null | undefined;
    const timingOut = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new URL(String(input)).pathname);
      signal = init?.signal;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const r = await putSender(cookie, 'sms', {}, { impl: timingOut, calls });
    expect(r.status).toBe(502);
    expect(await errorOf(r)).toEqual({
      code: 'internal_error',
      message: 'Your phone provider could not be reached. Try again in a moment.',
    });
    expect(calls).toEqual(['/v2/phone_numbers']);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(await connectionsOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'provider_error', channel: 'sms' },
    ]);
  });

  it('answers 409 credential_changed when the key is replaced during the check', async () => {
    const { cookie, orgId } = await ownerWithCredential('snd-rotate', num(13));
    const owned = owningAll();
    const calls: string[] = [];
    // Telnyx answers while a reconnect replaces the saved key, between the check and the write.
    const rotating = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await withAdminDb((db) =>
        db
          .update(providerCredential)
          .set({ apiKeyCiphertext: 'rotated-ciphertext' })
          .where(eq(providerCredential.organizationId, orgId)),
      );
      return owned.impl(input, init);
    }) as typeof fetch;
    const r = await putSender(cookie, 'sms', {}, { impl: rotating, calls });
    expect(r.status).toBe(409);
    expect(await errorOf(r)).toEqual({
      code: 'credential_changed',
      message: 'Your phone connection changed while saving. Try again.',
    });
    expect(await connectionsOf(orgId)).toEqual([]);
    expect(await routesOf(orgId)).toEqual([]);
    expect((await auditsOf(orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'credential_changed', channel: 'sms' },
    ]);
  });

  it('answers 409 with generic copy for a number another workspace routes', async () => {
    const number = num(4);
    const owner = await ownerWithCredential('snd-own', number);
    expect((await putSender(owner.cookie, 'sms', {})).status).toBe(200);
    // Telnyx says the other org owns it too (a reassigned number): the route still wins.
    const other = await ownerWithCredential('snd-other', number);
    const r = await putSender(other.cookie, 'sms', {});
    expect(r.status).toBe(409);
    const error = await errorOf(r);
    expect(error).toEqual({
      code: 'validation_error',
      message: "This number can't be used as a sender.",
    });
    expect(error?.message).not.toMatch(/workspace|another/i);
    expect(await routesOf(other.orgId)).toEqual([]);
    expect(await connectionsOf(other.orgId)).toEqual([]);
    expect((await auditsOf(other.orgId, 'denied')).map((a) => a.metadata)).toEqual([
      { reason: 'address_in_use', channel: 'sms' },
    ]);
  });

  it('replaces the connection on an address change, so the old number stops resolving', async () => {
    const before = num(5);
    const after = num(6);
    const { cookie, orgId } = await ownerWithCredential('snd-move', before, [before, after]);
    const first = await putSender(cookie, 'sms', {});
    expect(first.status).toBe(200);
    const oldId = bySms(await itemsOf(first), 'sms')?.id;
    expect((await resolveWith('sms', before))?.orgId).toBe(orgId);

    const second = await putSender(cookie, 'sms', { address: after });
    expect(second.status).toBe(200);
    expect(await resolveWith('sms', before)).toBeNull();
    const moved = await resolveWith('sms', after);
    expect(moved?.orgId).toBe(orgId);
    const conns = await connectionsOf(orgId);
    expect(conns.map((c) => [c.channel, c.address])).toEqual([['sms', after]]);
    expect(conns[0]?.id).not.toBe(oldId);
    expect(moved?.connectionId).toBe(conns[0]?.id);
    expect((await routesOf(orgId)).map((r) => r.address)).toEqual([after]);
  });

  describe('routes do not outlive the credential (ruling AP)', () => {
    const voicePut = (cookie: string, apiKey: string, callerIdE164: string) =>
      api('/api/v1/voice/connection', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ apiKey, connectionId: '1234567890', callerIdE164 }),
      });

    async function liveSenders(label: string, number: string) {
      const owner = await ownerWithCredential(label, number);
      expect((await putSender(owner.cookie, 'sms', {})).status).toBe(200);
      expect((await putSender(owner.cookie, 'whatsapp', {})).status).toBe(200);
      expect((await resolveWith('sms', number))?.orgId).toBe(owner.orgId);
      expect((await resolveWith('whatsapp', number))?.orgId).toBe(owner.orgId);
      return owner;
    }

    async function expectReleased(orgId: string, number: string, label: string) {
      expect(await resolveWith('sms', number)).toBeNull();
      expect(await resolveWith('whatsapp', number)).toBeNull();
      expect((await connectionsOf(orgId)).filter((c) => c.provider === 'telnyx')).toEqual([]);
      expect(await routesOf(orgId)).toEqual([]);
      // Another workspace that now holds the number can register it.
      const next = await ownerWithCredential(label, number);
      expect((await putSender(next.cookie, 'sms', {})).status).toBe(200);
      expect((await resolveWith('sms', number))?.orgId).toBe(next.orgId);
    }

    it('disconnecting Telnyx drops the telnyx senders and their routes', async () => {
      const number = num(14);
      const owner = await liveSenders('snd-ap-del', number);
      const r = await api('/api/v1/voice/connection', {
        method: 'DELETE',
        headers: { cookie: owner.cookie },
      });
      expect(r.status).toBe(204);
      await expectReleased(owner.orgId, number, 'snd-ap-del-next');
    });

    it('a different API key drops the telnyx senders and their routes', async () => {
      const number = num(15);
      const owner = await liveSenders('snd-ap-key', number);
      const r = await voicePut(owner.cookie, 'KEY0OTHERACCOUNT0000000000ab', number);
      expect(r.status).toBe(200);
      await expectReleased(owner.orgId, number, 'snd-ap-key-next');
    });

    it('re-saving the same key keeps the senders', async () => {
      const number = num(16);
      const owner = await liveSenders('snd-ap-same', number);
      const r = await voicePut(owner.cookie, TEST_TELNYX_API_KEY, number);
      expect(r.status).toBe(200);
      expect((await resolveWith('sms', number))?.orgId).toBe(owner.orgId);
      expect((await connectionsOf(owner.orgId)).map((c) => [c.channel, c.provider]).sort()).toEqual(
        [
          ['sms', 'telnyx'],
          ['whatsapp', 'telnyx'],
        ],
      );
    });

    it('disconnecting keeps a sandbox sender', async () => {
      const cookie = await signUp(uniqueEmail('snd-ap-sbx'), 'Owner Sandbox');
      const orgId = await orgOf(cookie);
      expect(
        (await put('/api/v1/messaging/sandbox', cookie, { sms: 'approved', whatsapp: 'approved' }))
          .status,
      ).toBe(200);
      await saveTelnyxCredential(orgId, null);
      const r = await api('/api/v1/voice/connection', { method: 'DELETE', headers: { cookie } });
      expect(r.status).toBe(204);
      expect((await connectionsOf(orgId)).map((c) => c.provider)).toEqual(['fake', 'fake']);
    });
  });

  describe('the number sync keeps telnyx senders in step (ruling AQ)', () => {
    it('refreshes the registration status, and drops a sender whose number left', async () => {
      const number = num(17);
      const { cookie, orgId } = await ownerWithCredential('snd-sync', number);
      await setSynced(orgId, number, { tenDlcStatus: 'pending' });
      expect((await putSender(cookie, 'sms', {})).status).toBe(200);
      expect((await connectionsOf(orgId))[0]?.registrationStatus).toBe('pending');

      await syncAs(orgId, 'telnyx', listing([{ e164: number, tenDlc: 'registered' }]));
      expect((await connectionsOf(orgId))[0]?.registrationStatus).toBe('approved');

      await syncAs(orgId, 'telnyx', listing([{ e164: number, tenDlc: 'failed' }]));
      expect((await connectionsOf(orgId))[0]?.registrationStatus).toBe('rejected');

      // Telnyx no longer lists the number: the workspace no longer controls it.
      await syncAs(orgId, 'telnyx', listing([]));
      expect(await connectionsOf(orgId)).toEqual([]);
      expect(await resolveWith('sms', number)).toBeNull();
    });

    it('takes the WhatsApp status from the sync, and keeps it through an unread WhatsApp sync', async () => {
      const number = num(18);
      const { cookie, orgId } = await ownerWithCredential('snd-sync-wa', number);
      expect((await putSender(cookie, 'whatsapp', {})).status).toBe(200);
      const wa = (state: 'approved' | 'pending' | 'none', synced = true): NumbersProvider => ({
        listNumbers: async () => [
          {
            providerNumberId: `tn-${number.slice(1)}`,
            e164: number,
            status: 'active' as const,
            capabilities: { voice: true, sms: true, mms: true, whatsapp: state !== 'none' },
            tenDlc: 'registered' as const,
            whatsapp: state,
            ...(synced ? {} : { whatsappSynced: false }),
          },
        ],
      });
      await syncAs(orgId, 'telnyx', wa('pending'));
      expect((await connectionsOf(orgId))[0]).toMatchObject({
        channel: 'whatsapp',
        registrationStatus: 'pending',
      });
      await syncAs(orgId, 'telnyx', wa('approved'));
      expect((await connectionsOf(orgId))[0]?.registrationStatus).toBe('approved');

      // The provider's WhatsApp facts could not be read: the sender and its status stay.
      await syncAs(orgId, 'telnyx', wa('none', false));
      expect((await connectionsOf(orgId))[0]?.registrationStatus).toBe('approved');
      expect((await resolveWith('whatsapp', number))?.orgId).toBe(orgId);

      // Telnyx says the number is no longer a WhatsApp number: the sender goes.
      await syncAs(orgId, 'telnyx', wa('none'));
      expect(await connectionsOf(orgId)).toEqual([]);
      expect(await resolveWith('whatsapp', number)).toBeNull();
    });

    it('makes an approved WhatsApp number the WhatsApp sender automatically', async () => {
      const number = num(21);
      const { orgId } = await ownerWithCredential('snd-sync-auto', number, []);
      await syncAs(orgId, 'telnyx', {
        listNumbers: async () => [
          {
            providerNumberId: `tn-${number.slice(1)}`,
            e164: number,
            status: 'active' as const,
            capabilities: { voice: true, sms: true, mms: true, whatsapp: true },
            tenDlc: 'none' as const,
            whatsapp: 'approved' as const,
            whatsappDetail: { displayName: 'Example Repairs', qualityRating: 'GREEN' },
          },
        ],
      });
      expect(
        (await connectionsOf(orgId)).map((c) => [c.channel, c.address, c.registrationStatus]),
      ).toEqual([['whatsapp', number, 'approved']]);
      expect((await resolveWith('whatsapp', number))?.orgId).toBe(orgId);
      const [synced] = await withAppDb((db) =>
        withTenant(db, orgId, (tx) =>
          tx.select().from(phoneNumber).where(eq(phoneNumber.e164, number)),
        ),
      );
      expect(synced).toMatchObject({
        whatsappDisplayName: 'Example Repairs',
        whatsappQualityRating: 'GREEN',
      });
    });

    it('drops an SMS sender whose synced number lost SMS', async () => {
      const number = num(18);
      const { cookie, orgId } = await ownerWithCredential('snd-sync-nosms', number);
      expect((await putSender(cookie, 'sms', {})).status).toBe(200);
      await setSynced(orgId, number, { sms: false });
      await withAppDb((db) => withTenant(db, orgId, (tx) => refreshTelnyxSenders(tx)));
      // The number still sends WhatsApp, so it becomes the WhatsApp sender; SMS is gone.
      expect((await connectionsOf(orgId)).map((c) => c.channel)).toEqual(['whatsapp']);
      expect(await resolveWith('sms', number)).toBeNull();
    });

    it('a fake-provider sync leaves telnyx senders alone', async () => {
      const number = num(19);
      const { cookie, orgId } = await ownerWithCredential('snd-sync-fake', number);
      expect((await putSender(cookie, 'sms', {})).status).toBe(200);
      await syncAs(orgId, 'fake', listing([]));
      expect((await connectionsOf(orgId)).map((c) => c.address)).toEqual([number]);
      expect((await resolveWith('sms', number))?.orgId).toBe(orgId);
    });
  });
});

describe('smsRegistration and sendableFor', () => {
  const row = (set: Partial<PhoneNumberRow>) =>
    ({
      provider: 'telnyx',
      status: 'active',
      voice: true,
      sms: true,
      mms: true,
      whatsapp: true,
      tenDlcStatus: 'none',
      whatsappStatus: 'none',
      ...set,
    }) as PhoneNumberRow;

  it.each([
    ['registered', 'approved'],
    ['not_required', 'approved'],
    ['pending', 'pending'],
    ['failed', 'rejected'],
    ['none', 'not_started'],
  ] as const)('maps 10DLC %s to %s for SMS', (tenDlcStatus, expected) => {
    expect(smsRegistration(row({ tenDlcStatus }))).toBe(expected);
  });

  it('allows only an active telnyx number with the channel capability', () => {
    expect(sendableFor(row({}), 'sms')).toBe('ok');
    expect(sendableFor(row({ status: 'pending' }), 'sms')).toBe('not_synced');
    expect(sendableFor(row({ status: 'inactive' }), 'whatsapp')).toBe('not_synced');
    expect(sendableFor(row({ provider: 'fake' }), 'sms')).toBe('not_synced');
    expect(sendableFor(undefined, 'sms')).toBe('not_synced');
    expect(sendableFor(row({ sms: false }), 'sms')).toBe('not_capable');
    // WhatsApp: the sync reads the account's WhatsApp numbers, so `whatsapp` is the evidence.
    expect(sendableFor(row({}), 'whatsapp')).toBe('ok');
    expect(sendableFor(row({ whatsapp: false }), 'whatsapp')).toBe('not_capable');
  });
});

/** resolveRoute as the webhook path calls it: the app role, no tenant. */
function resolveWith(channel: 'sms' | 'whatsapp', address: string) {
  return withAppDb((db) => resolveRoute(db, 'telnyx', channel, address));
}

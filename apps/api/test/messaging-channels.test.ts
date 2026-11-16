import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { OpenAPIHono } from '@hono/zod-openapi';
import { defaultComplianceTexts } from '@knoqra/core';
import { channelConnection, conversation, message, smsRegistration, withTenant } from '@knoqra/db';
import type { NumbersProvider } from '@knoqra/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { requestAuth } from '../src/lib/auth-context';
import type { AppEnv } from '../src/lib/context';
import { requestDb } from '../src/lib/db';
import { INTERRUPTED_FAILURE, sweepOrgDispatch } from '../src/messaging/dispatch-sweep';
import { advanceSmsRegistration } from '../src/messaging/sms-registration';
import { insertMessage } from '../src/messaging/store';
import { tenant } from '../src/middleware/tenant';
import { messagingChannelsRoutes } from '../src/routes/messaging-channels';
import { syncNumbers } from '../src/services/numbers';
import {
  get,
  saveTelnyxCredential,
  seedSyncedNumber,
  signUp,
  signUpTeammate,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';
import { consentedThread, data, sandboxOrg } from './messaging-helpers';

const telnyxEnv = {
  ...env,
  PROVIDER: 'telnyx',
  API_PUBLIC_ORIGIN: 'https://api.example.test',
} as unknown as Env;

type Channel = {
  state: string;
  address: string | null;
  detail: string;
  sandbox: boolean;
  enable: { available: boolean; reason: string };
  registration: { state: string; failureReason: string | null; phone: string } | null;
};
type Channels = { sms: Channel; whatsapp: Channel };

/** A scripted Telnyx 10DLC account: answers each documented call and records it (no network). */
function tenDlcAccount(e164: string) {
  const state = { identity: 'VERIFIED', campaign: 'TCR_PENDING', assigned: null as string | null };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace(/^\/v2/, '');
    calls.push({ method, path, body });
    const json = (status: number, payload: unknown) => Response.json(payload, { status });
    const route = `${method} ${path}`;
    if (route === 'GET /phone_numbers') {
      return json(200, { data: [{ id: '42', phone_number: e164, messaging_profile_id: null }] });
    }
    if (route === 'GET /messaging_profiles') return json(200, { data: [] });
    if (route === 'POST /messaging_profiles') return json(200, { data: { id: 'mp-1' } });
    if (route === 'PATCH /phone_numbers/42/messaging') return json(200, { data: { id: '42' } });
    if (route === 'POST /10dlc/brand') {
      return json(200, {
        brandId: 'b-1',
        identityStatus: body.entityType === 'SOLE_PROPRIETOR' ? 'SELF_DECLARED' : state.identity,
        status: 'OK',
      });
    }
    if (route === 'POST /10dlc/brand/b-1/smsOtp')
      return json(200, { brandId: 'b-1', referenceId: 'r-1' });
    if (route === 'PUT /10dlc/brand/b-1/smsOtp') {
      if (body.otpPin === '000000') return json(400, { errors: [{ code: '10015' }] });
      state.identity = 'VERIFIED';
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /10dlc/brand/b-1')
      return json(200, { brandId: 'b-1', identityStatus: state.identity, status: 'OK' });
    if (route === 'POST /10dlc/campaignBuilder')
      return json(200, { campaignId: 'c-1', campaignStatus: 'TCR_PENDING' });
    if (route === 'GET /10dlc/campaign/c-1')
      return json(200, { campaignId: 'c-1', campaignStatus: state.campaign });
    if (
      route === `GET /10dlc/phone_number_campaigns/${encodeURIComponent(e164)}` ||
      route === `GET /10dlc/phone_number_campaigns/${e164}`
    ) {
      return state.assigned
        ? json(200, { phoneNumber: e164, campaignId: 'c-1', assignmentStatus: state.assigned })
        : json(404, { errors: [{ code: '10005' }] });
    }
    if (route === 'POST /10dlc/phone_number_campaigns') {
      state.assigned = 'PENDING_ASSIGNMENT';
      return json(200, {
        phoneNumber: e164,
        campaignId: 'c-1',
        assignmentStatus: 'PENDING_ASSIGNMENT',
      });
    }
    throw new Error(`unexpected network call: ${route}`);
  }) as typeof fetch;
  return { impl, calls, state };
}

async function channelsRequest(
  fetchImpl: typeof fetch,
  cookie: string,
  path: string,
  init: RequestInit = {},
) {
  const app = new OpenAPIHono<AppEnv>();
  app.use('/api/v1/*', requestDb, requestAuth, tenant());
  app.route('/', messagingChannelsRoutes({ fetch: fetchImpl }));
  const ctx = createExecutionContext();
  const response = await app.request(
    path,
    { ...init, headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) } },
    telnyxEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function details(entityType: 'sole_proprietor' | 'private_profit', phone: string) {
  const texts = defaultComplianceTexts({ brandName: 'Pat Plumbing', email: 'pat@example.test' });
  return {
    entityType,
    phone,
    brandName: 'Pat Plumbing',
    ...(entityType === 'sole_proprietor'
      ? { firstName: 'Pat', lastName: 'Lee' }
      : { legalName: 'Pat Plumbing LLC', ein: '12-3456789' }),
    email: 'pat@example.test',
    contactPhone: '+12025550123',
    street: '1 Main St',
    city: 'Springfield',
    state: 'IL',
    postalCode: '62701',
    vertical: 'PROFESSIONAL',
    ...texts,
  };
}

let counter = 0;
async function connectedOwner(label: string) {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = await data<{ organization: { id: string } }>(await get('/api/v1/me', cookie));
  const number = `+1202555${String(150 + (counter++ % 20)).padStart(4, '0')}`;
  await saveTelnyxCredential(me.organization.id, number);
  await seedSyncedNumber(me.organization.id, number, {
    tenDlcStatus: 'none',
    whatsapp: false,
    whatsappStatus: 'none',
  });
  return { cookie, orgId: me.organization.id, number };
}

describe('GET /api/v1/messaging/channels', () => {
  it('shows sandbox senders as live, and that Enable needs a live deployment', async () => {
    const org = await sandboxOrg('channels-sbx');
    const channels = await data<Channels>(await get('/api/v1/messaging/channels', org.cookie));
    expect(channels.sms).toMatchObject({
      state: 'live',
      sandbox: true,
      address: null,
      enable: { reason: 'not_live' },
    });
    expect(channels.whatsapp.state).toBe('live');
  });

  it('shows a connected workspace with no senders as not enabled, ready to enable', async () => {
    const owner = await connectedOwner('channels-new');
    const channels = await data<Channels>(
      await channelsRequest(
        tenDlcAccount(owner.number).impl,
        owner.cookie,
        '/api/v1/messaging/channels',
      ),
    );
    expect(channels.sms).toMatchObject({
      state: 'not_enabled',
      enable: { available: true, reason: 'ok' },
      registration: null,
    });
    expect(channels.whatsapp.detail).toMatch(/WhatsApp Business number/);
  });
});

describe('SMS Enable (10DLC through the workspace provider account)', () => {
  it('registers a business: profile, number, brand and campaign, then the number once approved', async () => {
    const owner = await connectedOwner('sms-biz');
    const account = tenDlcAccount(owner.number);
    const r = await channelsRequest(
      account.impl,
      owner.cookie,
      '/api/v1/messaging/sms/registration',
      {
        method: 'POST',
        body: JSON.stringify(details('private_profit', owner.number)),
      },
    );
    expect(r.status).toBe(200);
    const after = await data<Channels>(r);
    expect(after.sms).toMatchObject({
      state: 'pending',
      registration: { state: 'campaign_pending', phone: owner.number },
    });
    expect(account.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /phone_numbers',
      'GET /messaging_profiles',
      'POST /messaging_profiles',
      'PATCH /phone_numbers/42/messaging',
      'POST /10dlc/brand',
      'GET /10dlc/brand/b-1',
      'POST /10dlc/campaignBuilder',
      'GET /10dlc/campaign/c-1',
    ]);
    const brand = account.calls.find((c) => c.path === '/10dlc/brand')?.body as Record<
      string,
      unknown
    >;
    expect(brand).toMatchObject({
      entityType: 'PRIVATE_PROFIT',
      companyName: 'Pat Plumbing LLC',
      ein: '12-3456789',
      country: 'US',
    });
    const [row] = await withAppDb((db) =>
      withTenant(db, owner.orgId, (tx) => tx.select().from(smsRegistration)),
    );
    const campaign = account.calls.find((c) => c.path === '/10dlc/campaignBuilder')?.body as Record<
      string,
      unknown
    >;
    expect(campaign).toMatchObject({
      brandId: 'b-1',
      usecase: 'CUSTOMER_CARE',
      referenceId: row?.id,
      optoutKeywords: 'STOP,UNSUBSCRIBE,CANCEL,END,QUIT',
    });

    account.state.campaign = 'MNO_PROVISIONED';
    expect(
      (
        await withAppDb((db) =>
          advanceSmsRegistration(db, telnyxEnv, owner.orgId, { fetch: account.impl }),
        )
      )?.state,
    ).toBe('number_pending');
    account.state.assigned = 'ASSIGNED';
    expect(
      (
        await withAppDb((db) =>
          advanceSmsRegistration(db, telnyxEnv, owner.orgId, { fetch: account.impl }),
        )
      )?.state,
    ).toBe('approved');

    // The number sync now reads the number as registered: it becomes the live SMS sender.
    const listing: NumbersProvider = {
      listNumbers: async () => [
        {
          providerNumberId: `tn-${owner.number.slice(1)}`,
          e164: owner.number,
          status: 'active',
          capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
          tenDlc: 'registered',
          whatsapp: 'none',
        },
      ],
    };
    await withAppDb((db) =>
      withTenant(db, owner.orgId, (tx) =>
        syncNumbers(tx, owner.orgId, 'telnyx', listing, new Date()),
      ),
    );
    const live = await data<Channels>(
      await channelsRequest(account.impl, owner.cookie, '/api/v1/messaging/channels'),
    );
    expect(live.sms).toMatchObject({
      state: 'live',
      address: owner.number,
      enable: { reason: 'done' },
    });
  });

  it('asks a sole proprietor for the texted code, then builds the campaign', async () => {
    const owner = await connectedOwner('sms-sole');
    const account = tenDlcAccount(owner.number);
    const submitted = await data<Channels>(
      await channelsRequest(account.impl, owner.cookie, '/api/v1/messaging/sms/registration', {
        method: 'POST',
        body: JSON.stringify(details('sole_proprietor', owner.number)),
      }),
    );
    expect(submitted.sms.registration?.state).toBe('otp_required');
    const otp = account.calls.find(
      (c) => c.method === 'POST' && c.path === '/10dlc/brand/b-1/smsOtp',
    )?.body as { pinSms: string };
    expect(otp.pinSms).toContain('@OTP_PIN@');
    const brand = account.calls.find((c) => c.path === '/10dlc/brand')?.body as Record<
      string,
      unknown
    >;
    expect(brand).toMatchObject({
      entityType: 'SOLE_PROPRIETOR',
      firstName: 'Pat',
      mobilePhone: '+12025550123',
    });
    expect(brand).not.toHaveProperty('ein');

    const wrong = await channelsRequest(
      account.impl,
      owner.cookie,
      '/api/v1/messaging/sms/registration/code',
      {
        method: 'POST',
        body: JSON.stringify({ pin: '000000' }),
      },
    );
    expect(wrong.status).toBe(422);
    const right = await data<Channels>(
      await channelsRequest(account.impl, owner.cookie, '/api/v1/messaging/sms/registration/code', {
        method: 'POST',
        body: JSON.stringify({ pin: '123456' }),
      }),
    );
    expect(right.sms.registration?.state).toBe('campaign_pending');
    const campaign = account.calls.find((c) => c.path === '/10dlc/campaignBuilder')?.body as Record<
      string,
      unknown
    >;
    expect(campaign.usecase).toBe('SOLE_PROPRIETOR');
  });

  it('refuses members, texts without the brand, a second submission, and a number not on the account', async () => {
    const owner = await connectedOwner('sms-refuse');
    const account = tenDlcAccount(owner.number);
    const mate = await signUpTeammate(owner.orgId);
    const body = details('private_profit', owner.number);
    const asMember = await channelsRequest(
      account.impl,
      mate.cookie,
      '/api/v1/messaging/sms/registration',
      { method: 'POST', body: JSON.stringify(body) },
    );
    expect(asMember.status).toBe(403);
    const noBrand = await channelsRequest(
      account.impl,
      owner.cookie,
      '/api/v1/messaging/sms/registration',
      {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          helpMessage: 'For help email us at help@example.test. Reply STOP to opt out.',
        }),
      },
    );
    expect(noBrand.status).toBe(400);
    expect(account.calls).toEqual([]);

    const elsewhere = tenDlcAccount('+12025559999');
    const missing = await data<Channels>(
      await channelsRequest(elsewhere.impl, owner.cookie, '/api/v1/messaging/sms/registration', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    expect(missing.sms.registration).toMatchObject({
      state: 'failed',
      failureReason: expect.stringMatching(/isn't on your phone provider account/),
    });

    // A failed registration can be submitted again; one in progress cannot.
    expect(
      (
        await channelsRequest(account.impl, owner.cookie, '/api/v1/messaging/sms/registration', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await channelsRequest(account.impl, owner.cookie, '/api/v1/messaging/sms/registration', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
  });
});

describe('dispatch sweep', () => {
  it('sends a message no worker claimed, and fails one whose send was interrupted', async () => {
    const org = await sandboxOrg('sweep');
    const t = await consentedThread(org, 'sms');
    // Queued messages whose background send never ran (a crash between the response and the send).
    const queue = (text: string) =>
      withAppDb((db) =>
        withTenant(db, org.orgId, async (tx) => {
          const [conv] = await tx
            .select()
            .from(conversation)
            .where(eq(conversation.id, t.conversationId));
          if (!conv) throw new Error('no conversation');
          const row = await insertMessage(tx, {
            orgId: org.orgId,
            conversation: conv,
            direction: 'outbound',
            body: text,
            status: 'queued',
            provider: 'fake',
            occurredAt: new Date(),
            dispatchPayload: { channel: 'sms', from: org.smsAddress, to: t.phone, body: text },
          });
          return row.id;
        }),
      );
    const lost = await queue('Never sent');
    const stuck = await queue('Half sent');
    const old = new Date(Date.now() - 20 * 60_000);
    await withAdminDb(async (db) => {
      await db.update(message).set({ createdAt: old }).where(eq(message.id, lost));
      await db
        .update(message)
        .set({ createdAt: old, dispatchClaimedAt: old })
        .where(eq(message.id, stuck));
    });
    const outcome = await withAppDb((db) => sweepOrgDispatch(db, env, org.orgId));
    expect(outcome).toEqual({ sent: 1, interrupted: 1 });
    const rows = await withAppDb((db) =>
      withTenant(db, org.orgId, (tx) =>
        tx.select().from(message).where(eq(message.conversationId, t.conversationId)),
      ),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(lost)?.providerMessageId).toMatch(/^fake_msg_/);
    expect(byId.get(lost)?.dispatchPayload).toBeNull();
    expect(byId.get(stuck)).toMatchObject({
      status: 'failed',
      errorMessage: INTERRUPTED_FAILURE.message,
      dispatchPayload: null,
    });
    // Nothing left to sweep.
    expect(await withAppDb((db) => sweepOrgDispatch(db, env, org.orgId))).toEqual({
      sent: 0,
      interrupted: 0,
    });
  });
});

/** This file's numbers (555-0150 to 0169): clear routes an earlier run left to other workspaces. */
beforeAll(async () => {
  const numbers = Array.from(
    { length: 20 },
    (_, i) => `+1202555${String(150 + i).padStart(4, '0')}`,
  );
  await withAdminDb((db) =>
    db
      .delete(channelConnection)
      .where(
        and(eq(channelConnection.provider, 'telnyx'), inArray(channelConnection.address, numbers)),
      ),
  );
});

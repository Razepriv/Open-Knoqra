import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  auditEvent,
  member,
  providerCredential,
  providerNumberRoute,
  withTenant,
} from '@knoqra/db';
import type { NumbersProvider } from '@knoqra/providers';
import { FakeProvider } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { syncNumbers } from '../src/services/numbers';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type NumberJson = {
  id: string;
  e164: string;
  provider: string;
  status: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean; whatsapp: boolean };
  tenDlcStatus: string;
  whatsappStatus: string;
  assignedUse: string;
  lastSyncedAt: string | null;
};
type SyncJson = { added: number; updated: number; deactivated: number; items: NumberJson[] };
type Org = { cookie: string; orgId: string };

const API_KEY = 'KEY0TESTONLY1234567890abcdef';

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

const patch = (id: string, cookie: string, body: unknown) =>
  api(`/api/v1/numbers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const list = async (cookie: string) =>
  ((await (await get('/api/v1/numbers', cookie)).json()) as Envelope<{ items: NumberJson[] }>).data
    ?.items ?? [];

async function sync(cookie: string): Promise<SyncJson> {
  const r = await post('/api/v1/numbers/sync', cookie, {});
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<SyncJson>).data as SyncJson;
}

const byE164 = (items: NumberJson[], e164: string) => {
  const found = items.find((n) => n.e164 === e164);
  if (!found) throw new Error(`no number ${e164}`);
  return found;
};

describe('numbers on the fake provider', () => {
  it('syncs three numbers, is idempotent, and lists active first by e164', async () => {
    const { cookie } = await newOrg('num-sync');
    expect(await list(cookie)).toEqual([]);
    const first = await sync(cookie);
    expect(first).toMatchObject({ added: 3, updated: 0, deactivated: 0 });
    expect(first.items.map((n) => n.e164)).toEqual([
      '+12025550100',
      '+12025550101',
      '+12025550102',
    ]);
    expect(first.items[0]).toMatchObject({
      provider: 'fake',
      status: 'active',
      capabilities: { voice: true, sms: true, mms: true, whatsapp: false },
      tenDlcStatus: 'registered',
      assignedUse: 'unassigned',
    });
    expect(first.items[0]?.lastSyncedAt).not.toBeNull();
    expect(first.items[2]).toMatchObject({ tenDlcStatus: 'pending', whatsappStatus: 'pending' });
    const second = await sync(cookie);
    expect(second).toMatchObject({ added: 0, updated: 3, deactivated: 0 });
    expect(await list(cookie)).toHaveLength(3);
  });

  it('marks a number the provider stops listing inactive and unassigned, never deleted', async () => {
    const { cookie, orgId } = await newOrg('num-remove');
    const { items } = await sync(cookie);
    const n100 = byE164(items, '+12025550100');
    expect((await patch(n100.id, cookie, { assignedUse: 'calls_and_messages' })).status).toBe(200);
    const all = await new FakeProvider({ webhookSecret: 'x' }).listNumbers();
    const reduced: NumbersProvider = { listNumbers: async () => all.slice(1) };
    const run = () =>
      withAppDb((db) =>
        withTenant(db, orgId, (tx) => syncNumbers(tx, orgId, 'fake', reduced, new Date())),
      );
    expect(await run()).toEqual({ added: 0, updated: 2, deactivated: 1 });
    const after = await list(cookie);
    expect(after).toHaveLength(3);
    expect(byE164(after, '+12025550100')).toMatchObject({
      status: 'inactive',
      assignedUse: 'unassigned',
    });
    // Inactive numbers sort after active ones.
    expect(after.map((n) => n.status)).toEqual(['active', 'active', 'inactive']);
    expect((await run()).deactivated).toBe(0);
    expect((await patch(n100.id, cookie, { assignedUse: 'calls' })).status).toBe(409);
  });

  it('assigns, and moves the calls use off the previous number', async () => {
    const { cookie, orgId } = await newOrg('num-assign');
    const { items } = await sync(cookie);
    const n100 = byE164(items, '+12025550100');
    const n101 = byE164(items, '+12025550101');
    const a = await patch(n100.id, cookie, { assignedUse: 'calls_and_messages' });
    expect(a.status).toBe(200);
    expect(((await a.json()) as Envelope<NumberJson>).data?.assignedUse).toBe('calls_and_messages');
    expect((await patch(n101.id, cookie, { assignedUse: 'calls' })).status).toBe(200);
    let now = await list(cookie);
    expect(byE164(now, '+12025550100').assignedUse).toBe('messages');
    expect(byE164(now, '+12025550101').assignedUse).toBe('calls');
    // A calls-only holder loses the use entirely.
    expect((await patch(n100.id, cookie, { assignedUse: 'calls' })).status).toBe(200);
    now = await list(cookie);
    expect(byE164(now, '+12025550101').assignedUse).toBe('unassigned');
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.action, 'numbers.assign'))),
    );
    expect(audits).toHaveLength(3);
    expect(audits[0]).toMatchObject({ outcome: 'allowed', entityType: 'numbers' });
  });

  it('rejects an invalid assignedUse', async () => {
    const { cookie } = await newOrg('num-badbody');
    const { items } = await sync(cookie);
    const r = await patch(items[0]?.id as string, cookie, { assignedUse: 'everything' });
    expect(r.status).toBe(400);
  });

  it('403 for a member on sync and assign, with a denied audit', async () => {
    const { cookie, orgId } = await newOrg('num-role');
    const { items } = await sync(cookie);
    await withAdminDb((db) =>
      db.update(member).set({ role: 'member' }).where(eq(member.organizationId, orgId)),
    );
    const s = await post('/api/v1/numbers/sync', cookie, {});
    expect(s.status).toBe(403);
    expect(((await s.json()) as Envelope<unknown>).error?.code).toBe('forbidden');
    const p = await patch(items[0]?.id as string, cookie, { assignedUse: 'calls' });
    expect(p.status).toBe(403);
    expect((await get('/api/v1/numbers', cookie)).status).toBe(200);
    const denied = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.organizationId, orgId), eq(auditEvent.outcome, 'denied'))),
    );
    expect(denied.map((a) => a.action).sort()).toEqual(['numbers.assign', 'numbers.sync']);
  });

  it('keeps tenants apart: empty list, and 404 plus a not_found audit for a foreign id', async () => {
    const a = await newOrg('num-tenant-a');
    const b = await newOrg('num-tenant-b');
    const { items } = await sync(a.cookie);
    expect(await list(b.cookie)).toEqual([]);
    const id = items[0]?.id as string;
    const r = await patch(id, b.cookie, { assignedUse: 'calls' });
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.organizationId, b.orgId), eq(auditEvent.action, 'numbers.assign')),
        ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: 'not_found', entityId: id });
    expect(byE164(await list(a.cookie), '+12025550100').assignedUse).toBe('unassigned');
    expect((await patch('nope', b.cookie, { assignedUse: 'calls' })).status).toBe(404);
  });

  it('two concurrent syncs both succeed and leave exactly three rows', async () => {
    const { cookie } = await newOrg('num-race-sync');
    const results = await Promise.all([
      post('/api/v1/numbers/sync', cookie, {}),
      post('/api/v1/numbers/sync', cookie, {}),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await list(cookie)).toHaveLength(3);
  });

  it('two concurrent assigns of different numbers to calls leave one calls holder', async () => {
    const { cookie } = await newOrg('num-race-assign');
    const { items } = await sync(cookie);
    const a = byE164(items, '+12025550100');
    const b = byE164(items, '+12025550101');
    const results = await Promise.all([
      patch(a.id, cookie, { assignedUse: 'calls' }),
      patch(b.id, cookie, { assignedUse: 'calls' }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const holders = (await list(cookie)).filter((n) =>
      ['calls', 'calls_and_messages'].includes(n.assignedUse),
    );
    expect(holders).toHaveLength(1);
  });

  it('401 without a session', async () => {
    expect((await api('/api/v1/numbers')).status).toBe(401);
  });
});

describe('numbers on the telnyx provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const telnyxEnv = { ...env, PROVIDER: 'telnyx' } as unknown as Env;

  async function request(path: string, cookie: string, method: string, body?: unknown) {
    const ctx = createExecutionContext();
    const response = await app.request(
      path,
      {
        method,
        headers: { 'content-type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      telnyxEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  function stubTelnyx(e164s: string[]) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/phone_numbers')) {
        const page = {
          data: e164s.map((e164) => ({
            id: `tn-${e164.slice(-4)}`,
            phone_number: e164,
            status: 'active',
            connection_id: 'conn-1',
            messaging_profile_id: null,
          })),
          meta: { total_pages: 1, page_number: 1 },
        };
        return new Response(JSON.stringify(page), { status: 200 });
      }
      if (url.includes('/10dlc/')) {
        return new Response(JSON.stringify({ records: [] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  async function freeRoute(e164: string) {
    await withAdminDb((db) =>
      db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, e164)),
    );
  }

  async function connect(cookie: string, callerId: string) {
    await freeRoute(callerId);
    const r = await api('/api/v1/voice/connection', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ apiKey: API_KEY, connectionId: '1234567890', callerIdE164: callerId }),
    });
    expect(r.status).toBe(200);
  }

  const itemsOf = async (r: Response) => ((await r.json()) as Envelope<SyncJson>).data?.items ?? [];

  it('assign writes caller_id_e164 and a provider_number_route row', async () => {
    const { cookie, orgId } = await newOrg('num-telnyx');
    await connect(cookie, '+12025550130');
    await freeRoute('+12025550131');
    stubTelnyx(['+12025550130', '+12025550131']);
    const s = await request('/api/v1/numbers/sync', cookie, 'POST', {});
    expect(s.status).toBe(200);
    const items = await itemsOf(s);
    expect(items.map((n) => n.provider)).toEqual(['telnyx', 'telnyx']);
    const target = byE164(items, '+12025550131');
    const r = await request(`/api/v1/numbers/${target.id}`, cookie, 'PATCH', {
      assignedUse: 'calls_and_messages',
    });
    expect(r.status).toBe(200);
    const [credential] = await withAdminDb((db) =>
      db.select().from(providerCredential).where(eq(providerCredential.organizationId, orgId)),
    );
    expect(credential?.callerIdE164).toBe('+12025550131');
    const routes = await withAdminDb((db) =>
      db.select().from(providerNumberRoute).where(eq(providerNumberRoute.organizationId, orgId)),
    );
    expect(routes.map((x) => x.e164)).toEqual(['+12025550131']);
  });

  it('409 when the number is routed to another workspace, and nothing changes', async () => {
    const a = await newOrg('num-telnyx-a');
    const b = await newOrg('num-telnyx-b');
    await connect(a.cookie, '+12025550132');
    await freeRoute('+12025550133');
    await withAdminDb((db) =>
      db
        .insert(providerNumberRoute)
        .values({ provider: 'telnyx', e164: '+12025550133', organizationId: b.orgId }),
    );
    stubTelnyx(['+12025550132', '+12025550133']);
    const items = await itemsOf(await request('/api/v1/numbers/sync', a.cookie, 'POST', {}));
    const first = byE164(items, '+12025550132');
    const clash = byE164(items, '+12025550133');
    expect(
      (await request(`/api/v1/numbers/${first.id}`, a.cookie, 'PATCH', { assignedUse: 'calls' }))
        .status,
    ).toBe(200);
    const r = await request(`/api/v1/numbers/${clash.id}`, a.cookie, 'PATCH', {
      assignedUse: 'calls',
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error).toEqual({
      code: 'validation_error',
      message: 'This number is connected to another workspace',
    });
    const now = (
      (await (await request('/api/v1/numbers', a.cookie, 'GET')).json()) as Envelope<{
        items: NumberJson[];
      }>
    ).data?.items;
    expect(byE164(now ?? [], '+12025550132').assignedUse).toBe('calls');
    expect(byE164(now ?? [], '+12025550133').assignedUse).toBe('unassigned');
    const [credential] = await withAdminDb((db) =>
      db.select().from(providerCredential).where(eq(providerCredential.organizationId, a.orgId)),
    );
    expect(credential?.callerIdE164).toBe('+12025550132');
    await freeRoute('+12025550133');
  });

  it('a messages-only assignment leaves the caller id and routes alone', async () => {
    const { cookie, orgId } = await newOrg('num-telnyx-msg');
    await connect(cookie, '+12025550135');
    await freeRoute('+12025550136');
    stubTelnyx(['+12025550135', '+12025550136']);
    const items = await itemsOf(await request('/api/v1/numbers/sync', cookie, 'POST', {}));
    const target = byE164(items, '+12025550136');
    const r = await request(`/api/v1/numbers/${target.id}`, cookie, 'PATCH', {
      assignedUse: 'messages',
    });
    expect(r.status).toBe(200);
    const [credential] = await withAdminDb((db) =>
      db.select().from(providerCredential).where(eq(providerCredential.organizationId, orgId)),
    );
    expect(credential?.callerIdE164).toBe('+12025550135');
    const routes = await withAdminDb((db) =>
      db.select().from(providerNumberRoute).where(eq(providerNumberRoute.organizationId, orgId)),
    );
    expect(routes.map((x) => x.e164)).toEqual(['+12025550135']);
  });

  it('a provider failure is 502 provider_unavailable with no provider text', async () => {
    const { cookie } = await newOrg('num-telnyx-down');
    await connect(cookie, '+12025550134');
    vi.stubGlobal(
      'fetch',
      async () => new Response('provider-secret-body KEY0TESTONLY', { status: 500 }),
    );
    const r = await request('/api/v1/numbers/sync', cookie, 'POST', {});
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toContain('provider-secret-body');
    expect(text).not.toContain(API_KEY);
    expect(JSON.parse(text)).toEqual({
      data: null,
      error: {
        code: 'provider_unavailable',
        message: 'Telnyx did not answer. Try again in a minute.',
      },
    });
  });

  it('sync is 409 voice_not_configured when no provider applies', async () => {
    const { cookie } = await newOrg('num-none');
    const ctx = createExecutionContext();
    const r = await app.request(
      '/api/v1/numbers/sync',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' },
      { ...env, FAKE_WEBHOOK_SECRET: undefined } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('voice_not_configured');
  });
});

import { callCostMicros } from '@knoqra/core';
import { call, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { openProviderAccess } from '../src/lib/provider-access';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

const MASTER_KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=';
const OTHER_KEY = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';
const API_KEY = 'KEY0TESTONLY1234567890abcdef';

const envOf = (over: Partial<Env> = {}): Env =>
  ({
    APP_ENV: 'test',
    FAKE_WEBHOOK_SECRET: 'test-only-fake-webhook-secret',
    CREDENTIALS_MASTER_KEY: MASTER_KEY,
    ...over,
  }) as Env;

async function newOrg(label: string): Promise<{ cookie: string; orgId: string }> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

const open = (orgId: string, env: Env, opts?: Parameters<typeof openProviderAccess>[3]) =>
  withAppDb((db) => withTenant(db, orgId, (tx) => openProviderAccess(tx, env, orgId, opts)));

async function connect(cookie: string, callerId: string) {
  await withAdminDb(async (db) => {
    const { providerNumberRoute } = await import('@knoqra/db');
    await db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, callerId));
  });
  const r = await api('/api/v1/voice/connection', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiKey: API_KEY, connectionId: '1234567890', callerIdE164: callerId }),
  });
  expect(r.status).toBe(200);
}

describe('openProviderAccess', () => {
  it('fake env: kind fake with one usage record per billed terminal call', async () => {
    const { cookie, orgId } = await newOrg('pa-fake');
    const contact = await post('/api/v1/contacts', cookie, {
      displayName: 'Usage Caller',
      phone: '+12025550123',
    });
    const contactId = ((await contact.json()) as Envelope<{ id: string }>).data?.id;
    const grant = await api(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ status: 'granted' }),
    });
    expect(grant.status).toBe(200);
    const dial = await post('/api/v1/calls', cookie, {
      contactId,
      idempotencyKey: `pa-${crypto.randomUUID()}`,
    });
    expect(dial.status).toBe(201);
    const callId = ((await dial.json()) as Envelope<{ call: { id: string } }>).data?.call.id;
    if (!callId) throw new Error('no call id');

    const endedAt = new Date('2026-11-12T10:00:00.000Z');
    const before = await open(orgId, envOf());
    expect(before.kind).toBe('fake');
    if (before.kind === 'none') throw new Error('unreachable');
    expect(
      await before.usage.fetchUsage({ from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }),
    ).toEqual([]);

    await withAdminDb((db) =>
      db
        .update(call)
        .set({ state: 'completed', billableSeconds: 61, endedAt })
        .where(eq(call.id, callId)),
    );
    const access = await open(orgId, envOf());
    if (access.kind === 'none') throw new Error('unreachable');
    const usage = await access.usage.fetchUsage({
      from: '2026-01-01T00:00:00Z',
      to: '2027-01-01T00:00:00Z',
    });
    expect(usage).toEqual([
      {
        service: 'voice',
        quantity: 61,
        unit: 'second',
        costMicros: callCostMicros(61),
        occurredAt: endedAt.toISOString(),
        providerRef: `fake_call_${callId}`,
      },
    ]);
    expect(usage[0]?.costMicros).toBe(20_000);
    expect((await access.balance.fetchBalance()).balanceMicros).toBe(50_000_000);
    const custom = await open(orgId, envOf(), { fakeBalanceMicros: 1_234_000 });
    if (custom.kind === 'none') throw new Error('unreachable');
    expect((await custom.balance.fetchBalance()).balanceMicros).toBe(1_234_000);
  });

  it('telnyx env with a stored connection: kind telnyx, balance read through the injected fetch', async () => {
    const { cookie, orgId } = await newOrg('pa-telnyx');
    await connect(cookie, '+12025550120');
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: { balance: '12.50', currency: 'USD' } }), {
        status: 200,
      });
    };
    const access = await open(orgId, envOf({ PROVIDER: 'telnyx' }), { fetch: fetchImpl });
    expect(access.kind).toBe('telnyx');
    if (access.kind === 'none') throw new Error('unreachable');
    expect((await access.balance.fetchBalance()).balanceMicros).toBe(12_500_000);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/balance$/);
  });

  it('production with no connection: none', async () => {
    const { orgId } = await newOrg('pa-prod');
    const access = await open(orgId, envOf({ APP_ENV: 'production', PROVIDER: 'telnyx' }));
    expect(access).toEqual({ kind: 'none' });
  });

  it('a wrong master key: none, without throwing', async () => {
    const { cookie, orgId } = await newOrg('pa-wrongkey');
    await connect(cookie, '+12025550121');
    const wrong = await open(
      orgId,
      envOf({ PROVIDER: 'telnyx', CREDENTIALS_MASTER_KEY: OTHER_KEY }),
    );
    expect(wrong).toEqual({ kind: 'none' });
    const missing = await open(
      orgId,
      envOf({ PROVIDER: 'telnyx', CREDENTIALS_MASTER_KEY: undefined, APP_ENV: 'production' }),
    );
    expect(missing).toEqual({ kind: 'none' });
  });
});

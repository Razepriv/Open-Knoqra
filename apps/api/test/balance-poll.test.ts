import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { auditEvent, member, providerBalanceSnapshot, withTenant } from '@knoqra/db';
import { TelnyxApiError } from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import type { ProviderAccess } from '../src/lib/provider-access';
import { pollOrgBalance } from '../src/services/balance-poll';
import {
  api,
  get,
  NO_PURCHASE,
  post,
  signUp,
  uniqueEmail,
  withAdminDb,
  withAppDb,
} from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Org = { cookie: string; orgId: string; userId: string };
type BalanceJson = {
  wallet: unknown;
  provider: { status: string; balanceMicros: number | null; capturedAt: string } | null;
  spend: { outcome: string; reason: string };
};

async function newOrg(label: string): Promise<Org> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
    user: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  const userId = body.data?.user.id;
  if (!orgId || !userId) throw new Error('no active organization');
  return { cookie, orgId, userId };
}

const snapshots = (orgId: string) =>
  withAdminDb((db) =>
    db
      .select()
      .from(providerBalanceSnapshot)
      .where(eq(providerBalanceSnapshot.organizationId, orgId)),
  );

const seed = (orgId: string, balanceMicros: number) =>
  withAdminDb((db) =>
    db.insert(providerBalanceSnapshot).values({
      organizationId: orgId,
      provider: 'fake',
      status: 'ok',
      balanceMicros,
      currency: 'USD',
    }),
  );

const failing = (error: Error): ProviderAccess => ({
  kind: 'telnyx',
  numbers: { listNumbers: async () => [] },
  purchase: NO_PURCHASE,
  connectionId: null,
  balance: {
    fetchBalance: async () => {
      throw error;
    },
  },
  usage: { fetchUsage: async () => [] },
});

const poll = (orgId: string, opts?: Parameters<typeof pollOrgBalance>[3]) =>
  withAppDb((db) => pollOrgBalance(db, env as Env, orgId, opts));

const balanceOf = async (cookie: string) =>
  ((await (await get('/api/v1/usage/balance', cookie)).json()) as Envelope<BalanceJson>).data;

describe('pollOrgBalance', () => {
  it('stores an ok snapshot from the fake provider', async () => {
    const o = await newOrg('poll-fake');
    const json = await poll(o.orgId);
    expect(json).toMatchObject({ status: 'ok', balanceMicros: 50_000_000 });
    const rows = await snapshots(o.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'fake', status: 'ok', balanceMicros: 50_000_000 });
  });

  it('records auth_failed on 401 and 403, unavailable on other errors', async () => {
    const o = await newOrg('poll-errors');
    expect((await poll(o.orgId, { access: failing(new TelnyxApiError(401, 'x')) }))?.status).toBe(
      'auth_failed',
    );
    expect((await poll(o.orgId, { access: failing(new TelnyxApiError(403, 'x')) }))?.status).toBe(
      'auth_failed',
    );
    expect((await poll(o.orgId, { access: failing(new TelnyxApiError(500, 'x')) }))?.status).toBe(
      'unavailable',
    );
    const net = await poll(o.orgId, { access: failing(new TypeError('network')) });
    expect(net).toMatchObject({ status: 'unavailable', balanceMicros: null });
    expect((await snapshots(o.orgId)).map((r) => r.status).sort()).toEqual([
      'auth_failed',
      'auth_failed',
      'unavailable',
      'unavailable',
    ]);
  });

  it('writes no row when the provider is none', async () => {
    const o = await newOrg('poll-none');
    expect(await poll(o.orgId, { access: { kind: 'none' } })).toBeNull();
    expect(await snapshots(o.orgId)).toHaveLength(0);
  });
});

describe('GET /api/v1/usage/balance', () => {
  it('returns a null provider and an ok decision without a snapshot', async () => {
    const o = await newOrg('bal-none');
    const body = await balanceOf(o.cookie);
    expect(body?.provider).toBeNull();
    expect(body?.spend).toEqual({ outcome: 'ok', reason: 'ok' });
  });

  it('merges the provider decision: 1,000,000 warns provider_low', async () => {
    const o = await newOrg('bal-low');
    await seed(o.orgId, 1_000_000);
    const body = await balanceOf(o.cookie);
    expect(body?.provider).toMatchObject({ status: 'ok', balanceMicros: 1_000_000 });
    expect(body?.spend).toEqual({ outcome: 'warn', reason: 'provider_low' });
  });

  it('never shows org A snapshot to org B', async () => {
    const a = await newOrg('bal-a');
    const b = await newOrg('bal-b');
    await seed(a.orgId, 1_000_000);
    const body = await balanceOf(b.cookie);
    expect(body?.provider).toBeNull();
    expect(body?.spend.outcome).toBe('ok');
  });
});

describe('POST /api/v1/usage/balance/refresh', () => {
  it('polls now for an owner and audits it', async () => {
    const o = await newOrg('refresh-owner');
    const r = await post('/api/v1/usage/balance/refresh', o.cookie, {});
    expect(r.status).toBe(200);
    const body = ((await r.json()) as Envelope<BalanceJson>).data;
    expect(body?.provider).toMatchObject({ status: 'ok', balanceMicros: 50_000_000 });
    const audits = await withAppDb((db) =>
      withTenant(db, o.orgId, (tx) =>
        tx.select().from(auditEvent).where(eq(auditEvent.action, 'usage.balance.refresh')),
      ),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe('allowed');
  });

  it('refuses a plain member with 403 and polls nothing', async () => {
    const o = await newOrg('refresh-member');
    await withAdminDb((db) =>
      db
        .update(member)
        .set({ role: 'member' })
        .where(and(eq(member.organizationId, o.orgId), eq(member.userId, o.userId))),
    );
    const r = await post('/api/v1/usage/balance/refresh', o.cookie, {});
    expect(r.status).toBe(403);
    expect(await snapshots(o.orgId)).toHaveLength(0);
  });
});

describe('POST /api/v1/dev/fake-provider/balance', () => {
  it('sets the fake balance and polls it', async () => {
    const o = await newOrg('dev-balance');
    const r = await api('/api/v1/dev/fake-provider/balance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: o.cookie },
      body: JSON.stringify({ balanceMicros: 1_234_000 }),
    });
    expect(r.status).toBe(202);
    expect((await snapshots(o.orgId))[0]).toMatchObject({ status: 'ok', balanceMicros: 1_234_000 });
  });

  it('keeps a seeded fake balance: refresh polls the same 1,000,000 and still warns provider_low', async () => {
    const o = await newOrg('dev-balance-sticky');
    const seeded = await api('/api/v1/dev/fake-provider/balance', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: o.cookie },
      body: JSON.stringify({ balanceMicros: 1_000_000 }),
    });
    expect(seeded.status).toBe(202);
    const r = await post('/api/v1/usage/balance/refresh', o.cookie, {});
    expect(r.status).toBe(200);
    const body = ((await r.json()) as Envelope<BalanceJson>).data;
    expect(body?.provider).toMatchObject({ status: 'ok', balanceMicros: 1_000_000 });
    expect(body?.spend).toMatchObject({ outcome: 'warn', reason: 'provider_low' });
    const rows = await snapshots(o.orgId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.balanceMicros === 1_000_000)).toBe(true);
  });

  it('404 in production', async () => {
    const o = await newOrg('dev-balance-prod');
    const ctx = createExecutionContext();
    const r = await app.request(
      '/api/v1/dev/fake-provider/balance',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: o.cookie },
        body: JSON.stringify({ balanceMicros: 5 }),
      },
      { ...env, APP_ENV: 'production' } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(r.status).toBe(404);
    expect(await snapshots(o.orgId)).toHaveLength(0);
  });
});

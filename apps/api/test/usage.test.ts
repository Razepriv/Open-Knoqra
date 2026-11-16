import { newId } from '@knoqra/core';
import { withTenant } from '@knoqra/db';
import { describe, expect, it } from 'vitest';
import { ensureWallet, reserve, settleReservation } from '../src/services/ledger';
import { channelOfRef, describeEntry, USAGE_CHANNELS } from '../src/services/usage-ledger';
import { get, signUp, uniqueEmail, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Row = {
  id: string;
  createdAt: string;
  kind: string;
  channel: string;
  description: string;
  balanceDeltaMicros: number;
  heldDeltaMicros: number;
  balanceAfterMicros: number;
  heldAfterMicros: number;
  availableAfterMicros: number;
  refType: string | null;
  refId: string | null;
  note: string | null;
};
type Page = { items: Row[]; nextCursor: string | null };
type Summary = {
  from: string;
  to: string;
  days: {
    date: string;
    voice: number;
    sms: number;
    whatsapp: number;
    other: number;
    platformFee: number;
  }[];
  totals: Record<string, number>;
  platformFeeMicrosPerMinute: number;
};
type User = { cookie: string; orgId: string };

const STARTER = 5_000_000;
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function newUser(label: string): Promise<User> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

const inTenant = <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withAppDb((db) => withTenant(db, orgId, fn));

async function seed(orgId: string): Promise<void> {
  await inTenant(orgId, (tx) => ensureWallet(tx, orgId, { starterCredit: true }));
  const hold = async (key: string, refType: string) => {
    const result = await inTenant(orgId, (tx) =>
      reserve(tx, {
        orgId,
        amountMicros: 100_000,
        idempotencyKey: `${key}:reserve`,
        refType,
        refId: key,
        actorUserId: null,
      }),
    );
    if (!('entry' in result)) throw new Error('refused');
    return result.entry;
  };
  const settle = (key: string, refType: string, reservationId: string, costMicros: number) =>
    inTenant(orgId, (tx) =>
      settleReservation(tx, {
        orgId,
        reservationId,
        costMicros,
        idempotencyKey: `${key}:settle`,
        refType,
        refId: key,
      }),
    );
  const first = await hold(newId('cl'), 'call');
  await settle(first.refId as string, 'call', first.id, 20_000);
  const second = await hold(newId('cl'), 'call');
  await settle(second.refId as string, 'call', second.id, 0);
}

async function page<T>(u: User, path: string): Promise<{ status: number; body: Envelope<T> }> {
  const r = await get(path, u.cookie);
  return { status: r.status, body: (await r.json()) as Envelope<T> };
}

describe('channelOfRef', () => {
  it('maps ref types to channels', () => {
    expect(USAGE_CHANNELS).toEqual(['voice', 'sms', 'whatsapp', 'other']);
    expect(channelOfRef('call')).toBe('voice');
    expect(channelOfRef('sms')).toBe('sms');
    expect(channelOfRef('whatsapp')).toBe('whatsapp');
    expect(channelOfRef('test')).toBe('other');
    expect(channelOfRef(null)).toBe('other');
  });
});

describe('describeEntry', () => {
  it('labels number orders as number charges on the other channel', () => {
    expect(channelOfRef('number_order')).toBe('other');
    expect(describeEntry('reserve', 'other', null, 'number_order')).toBe('Hold for number');
    expect(describeEntry('capture', 'other', null, 'number_order')).toBe('Number charge');
    expect(describeEntry('release', 'other', null, 'number_order')).toBe('Hold released');
    expect(describeEntry('capture', 'voice', null, 'call')).toBe('Call charge');
    expect(describeEntry('capture', 'other', null, 'test')).toBe('other');
  });
});

describe('GET /api/v1/usage/ledger', () => {
  it('returns rows newest first with running balances', async () => {
    const u = await newUser('usage-ledger');
    await seed(u.orgId);
    const { status, body } = await page<Page>(u, '/api/v1/usage/ledger');
    expect(status).toBe(200);
    const items = body.data?.items ?? [];
    expect(
      items.map((r) => [r.kind, r.balanceAfterMicros, r.heldAfterMicros, r.availableAfterMicros]),
    ).toEqual([
      ['release', 4_980_000, 0, 4_980_000],
      ['reserve', 4_980_000, 100_000, 4_880_000],
      ['capture', 4_980_000, 0, 4_980_000],
      ['reserve', STARTER, 100_000, STARTER - 100_000],
      ['credit', STARTER, 0, STARTER],
    ]);
    expect(items.map((r) => r.description)).toEqual([
      'Hold released',
      'Hold for call',
      'Call charge',
      'Hold for call',
      'Development starter credit',
    ]);
    expect(items[2]).toMatchObject({
      channel: 'voice',
      balanceDeltaMicros: -20_000,
      heldDeltaMicros: -100_000,
    });
    expect(body.data?.nextCursor).toBeNull();
  });

  it('describes number order entries as number charges', async () => {
    const u = await newUser('usage-number');
    await inTenant(u.orgId, (tx) => ensureWallet(tx, u.orgId, { starterCredit: true }));
    const orderId = newId('no');
    const held = await inTenant(u.orgId, (tx) =>
      reserve(tx, {
        orgId: u.orgId,
        amountMicros: 2_000_000,
        idempotencyKey: `number-order:${orderId}:hold`,
        refType: 'number_order',
        refId: orderId,
        actorUserId: null,
      }),
    );
    if (!('entry' in held)) throw new Error('refused');
    await inTenant(u.orgId, (tx) =>
      settleReservation(tx, {
        orgId: u.orgId,
        reservationId: held.entry.id,
        costMicros: 2_000_000,
        idempotencyKey: `number-order:${orderId}:settle`,
        refType: 'number_order',
        refId: orderId,
      }),
    );
    const { body } = await page<Page>(u, '/api/v1/usage/ledger?channel=other');
    const orderRows = (body.data?.items ?? []).filter((r) => r.refType === 'number_order');
    expect(orderRows.map((r) => [r.kind, r.channel, r.description])).toEqual([
      ['capture', 'other', 'Number charge'],
      ['reserve', 'other', 'Hold for number'],
    ]);
  });

  it('keeps running balances when filtered', async () => {
    const u = await newUser('usage-filter');
    await seed(u.orgId);
    const capture = await page<Page>(u, '/api/v1/usage/ledger?kind=capture');
    expect(capture.body.data?.items).toHaveLength(1);
    expect(capture.body.data?.items[0]).toMatchObject({
      kind: 'capture',
      balanceAfterMicros: 4_980_000,
      heldAfterMicros: 0,
    });
    expect((await page<Page>(u, '/api/v1/usage/ledger?channel=sms')).body.data?.items).toEqual([]);
    const voice = await page<Page>(
      u,
      `/api/v1/usage/ledger?channel=voice&from=${day()}&to=${day()}`,
    );
    expect(voice.body.data?.items).toHaveLength(4);
    const past = await page<Page>(u, `/api/v1/usage/ledger?from=${day(-30)}&to=${day(-2)}`);
    expect(past.body.data?.items).toEqual([]);
  });

  it('pages with limit=2 without overlap', async () => {
    const u = await newUser('usage-paging');
    await seed(u.orgId);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const q: string = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r: { body: Envelope<Page> } = await page<Page>(u, `/api/v1/usage/ledger?${q}`);
      seen.push(...(r.body.data?.items.map((x) => x.id) ?? []));
      cursor = r.body.data?.nextCursor ?? null;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a malformed cursor and shows another org nothing', async () => {
    const a = await newUser('usage-cursor-a');
    await seed(a.orgId);
    const bad = await page<Page>(a, '/api/v1/usage/ledger?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    const b = await newUser('usage-cursor-b');
    const other = await page<Page>(b, '/api/v1/usage/ledger');
    expect(other.status).toBe(200);
    expect(other.body.data).toEqual({ items: [], nextCursor: null });
  });
});

describe('GET /api/v1/usage/summary', () => {
  it('sums spend per day and channel, with zero days and credits', async () => {
    const u = await newUser('usage-summary');
    await seed(u.orgId);
    const { status, body } = await page<Summary>(
      u,
      `/api/v1/usage/summary?from=${day(-2)}&to=${day()}`,
    );
    expect(status).toBe(200);
    const data = body.data as Summary;
    expect(data.days.map((d) => d.date)).toEqual([day(-2), day(-1), day()]);
    expect(data.days[0]).toEqual({
      date: day(-2),
      voice: 0,
      sms: 0,
      whatsapp: 0,
      other: 0,
      platformFee: 0,
    });
    expect(data.days[2]).toEqual({
      date: day(),
      voice: 20_000,
      sms: 0,
      whatsapp: 0,
      other: 0,
      platformFee: 0,
    });
    expect(data.totals).toEqual({
      voice: 20_000,
      sms: 0,
      whatsapp: 0,
      other: 0,
      adjustments: 0,
      credits: STARTER,
      platformFees: 0,
    });
    expect(data.platformFeeMicrosPerMinute).toBe(0);
  });

  it('rejects from after to, and ranges over 366 days', async () => {
    const u = await newUser('usage-range');
    expect(
      (await page<Summary>(u, `/api/v1/usage/summary?from=${day()}&to=${day(-1)}`)).status,
    ).toBe(400);
    expect(
      (await page<Summary>(u, `/api/v1/usage/summary?from=${day(-400)}&to=${day()}`)).status,
    ).toBe(400);
    expect(
      (await page<Summary>(u, '/api/v1/usage/summary?from=2026-02-30&to=2026-03-01')).status,
    ).toBe(400);
  });
});

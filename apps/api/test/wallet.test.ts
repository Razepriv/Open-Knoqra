import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { OpenAPIHono } from '@hono/zod-openapi';
import { auditEvent, member, withTenant } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { requestAuth } from '../src/lib/auth-context';
import type { AppEnv } from '../src/lib/context';
import { requestDb } from '../src/lib/db';
import { tenant } from '../src/middleware/tenant';
import { manualCreditAllowed, walletRoutes } from '../src/routes/wallet';
import { api, get, post, signUp, uniqueEmail, withAdminDb, withAppDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Summary = {
  currency: 'USD';
  balanceMicros: number;
  heldMicros: number;
  availableMicros: number;
  periodSpendMicros: number;
  warnCapMicros: number | null;
  stopCapMicros: number | null;
  status: { outcome: string; reason: string };
  dialStatus: { outcome: string; reason: string };
};
type LedgerItem = {
  id: string;
  kind: string;
  balanceDeltaMicros: number;
  heldDeltaMicros: number;
  note: string | null;
  createdAt: string;
};
type LedgerPage = { items: LedgerItem[]; nextCursor: string | null };

let cookieA: string;
let cookieB: string;
let orgA: string;

async function orgOf(cookie: string): Promise<string> {
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const id = body.data?.organization.id;
  if (!id) throw new Error('no active organization');
  return id;
}

function patch(path: string, cookie: string, body: unknown): Promise<Response> {
  return api(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

async function data<T>(r: Response): Promise<T> {
  const json = (await r.json()) as Envelope<T>;
  if (!json.data) throw new Error(`no data (${r.status}): ${JSON.stringify(json.error)}`);
  return json.data;
}

const errorCode = async (r: Response) => ((await r.json()) as Envelope<unknown>).error?.code;

beforeAll(async () => {
  cookieA = await signUp(uniqueEmail('wallet-a'));
  cookieB = await signUp(uniqueEmail('wallet-b'));
  orgA = await orgOf(cookieA);
});

describe('GET /api/v1/wallet', () => {
  it('returns the defaults with the development starter credit', async () => {
    const r = await get('/api/v1/wallet', cookieA);
    expect(r.status).toBe(200);
    expect(await data<Summary>(r)).toEqual({
      currency: 'USD',
      balanceMicros: 5_000_000,
      heldMicros: 0,
      availableMicros: 5_000_000,
      periodSpendMicros: 0,
      warnCapMicros: null,
      stopCapMicros: null,
      status: { outcome: 'ok', reason: 'ok' },
      dialStatus: { outcome: 'ok', reason: 'ok' },
    });
  });

  it('dialStatus judges the next call reserve while status judges the wallet as it is', async () => {
    const cookie = await signUp(uniqueEmail('wallet-dial'));
    // The reserve is $0.10, so a $0.05 stop cap blocks the next dial but not the wallet itself.
    const capped = await data<Summary>(
      await patch('/api/v1/wallet/caps', cookie, { stopCapMicros: 50_000 }),
    );
    expect(capped.status).toEqual({ outcome: 'ok', reason: 'ok' });
    expect(capped.dialStatus).toEqual({ outcome: 'stop', reason: 'stop_cap' });
    const warned = await data<Summary>(
      await patch('/api/v1/wallet/caps', cookie, { warnCapMicros: 100_000, stopCapMicros: null }),
    );
    expect(warned.status).toEqual({ outcome: 'ok', reason: 'ok' });
    expect(warned.dialStatus).toEqual({ outcome: 'warn', reason: 'warn_cap' });
  });

  it('requires a session', async () => {
    expect((await get('/api/v1/wallet')).status).toBe(401);
  });
});

describe('PATCH /api/v1/wallet/caps', () => {
  it('lets the owner set caps, audits and returns integers', async () => {
    const r = await patch('/api/v1/wallet/caps', cookieA, {
      warnCapMicros: 1_000_000,
      stopCapMicros: 2_000_000,
    });
    expect(r.status).toBe(200);
    const summary = await data<Summary>(r);
    expect(summary).toMatchObject({ warnCapMicros: 1_000_000, stopCapMicros: 2_000_000 });
    expect(Number.isInteger(summary.warnCapMicros)).toBe(true);
    // Only the given field changes.
    const off = await data<Summary>(
      await patch('/api/v1/wallet/caps', cookieA, { warnCapMicros: null }),
    );
    expect(off).toMatchObject({ warnCapMicros: null, stopCapMicros: 2_000_000 });
    const audits = await withAppDb((db) =>
      withTenant(db, orgA, (tx) =>
        tx.select().from(auditEvent).where(eq(auditEvent.action, 'wallet.caps.update')),
      ),
    );
    expect(audits.filter((a) => a.outcome === 'allowed').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses warn above stop with 400, including against the stored value', async () => {
    const r = await patch('/api/v1/wallet/caps', cookieA, {
      warnCapMicros: 3_000_000,
      stopCapMicros: 2_000_000,
    });
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toBe('validation_error');
    const merged = await patch('/api/v1/wallet/caps', cookieA, { warnCapMicros: 2_500_000 });
    expect(merged.status).toBe(400);
  });

  it('rejects negative and fractional caps', async () => {
    expect((await patch('/api/v1/wallet/caps', cookieA, { stopCapMicros: -1 })).status).toBe(400);
    expect((await patch('/api/v1/wallet/caps', cookieA, { stopCapMicros: 1.5 })).status).toBe(400);
  });

  it('forbids a member (403) for caps and credits', async () => {
    const cookie = await signUp(uniqueEmail('wallet-member'));
    const orgId = await orgOf(cookie);
    await withAdminDb((db) =>
      db.update(member).set({ role: 'member' }).where(eq(member.organizationId, orgId)),
    );
    const r = await patch('/api/v1/wallet/caps', cookie, { stopCapMicros: 1 });
    expect(r.status).toBe(403);
    expect(await errorCode(r)).toBe('forbidden');
    const c = await post('/api/v1/wallet/credits', cookie, {
      amountMicros: 1_000,
      note: 'Top-up',
      idempotencyKey: 'member-credit-1',
    });
    expect(c.status).toBe(403);
    // Members may still read.
    expect((await get('/api/v1/wallet', cookie)).status).toBe(200);
  });
});

describe('credits and ledger', () => {
  it('records a credit once per idempotency key', async () => {
    const body = { amountMicros: 250_000, note: 'Provider top-up', idempotencyKey: 'topup-0001' };
    const first = await post('/api/v1/wallet/credits', cookieA, body);
    expect(first.status).toBe(201);
    const again = await post('/api/v1/wallet/credits', cookieA, body);
    expect(again.status).toBe(200);
    const a = await data<{ entry: LedgerItem; wallet: Summary }>(first);
    const b = await data<{ entry: LedgerItem; wallet: Summary }>(again);
    expect(b.entry.id).toBe(a.entry.id);
    expect(b.wallet.balanceMicros).toBe(5_250_000);
    const conflict = await post('/api/v1/wallet/credits', cookieA, { ...body, amountMicros: 1 });
    expect(conflict.status).toBe(409);
  });

  it('validates the credit body', async () => {
    const bad = [
      { amountMicros: 0, note: 'x', idempotencyKey: 'abcdefgh' },
      { amountMicros: 1_000_000_001, note: 'x', idempotencyKey: 'abcdefgh' },
      { amountMicros: 10, note: '', idempotencyKey: 'abcdefgh' },
      { amountMicros: 10, note: 'x', idempotencyKey: 'short' },
      { amountMicros: 10, note: 'a\u0000b', idempotencyKey: 'abcdefgh' },
    ];
    for (const body of bad) {
      expect((await post('/api/v1/wallet/credits', cookieA, body)).status).toBe(400);
    }
  });

  it('pages the ledger newest first', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await post('/api/v1/wallet/credits', cookieA, {
        amountMicros: 1_000 + i,
        note: `Page ${i}`,
        idempotencyKey: `page-credit-${i}`,
      });
      expect(r.status).toBe(201);
    }
    const first = await data<LedgerPage>(await get('/api/v1/wallet/ledger?limit=2', cookieA));
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.note).toBe('Page 2');
    expect(first.nextCursor).not.toBeNull();
    const seen = new Set(first.items.map((i) => i.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await data<LedgerPage>(
        await get(`/api/v1/wallet/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`, cookieA),
      );
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
    }
    // starter credit + topup + 3 page credits
    expect(seen.size).toBe(5);
    expect((await get('/api/v1/wallet/ledger?cursor=nope', cookieA)).status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('org B has its own wallet and never sees org A', async () => {
    const b = await data<Summary>(await get('/api/v1/wallet', cookieB));
    expect(b.balanceMicros).toBe(5_000_000);
    expect(b.stopCapMicros).toBeNull();
    const ledger = await data<LedgerPage>(await get('/api/v1/wallet/ledger', cookieB));
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]?.kind).toBe('credit');
  });
});

describe('manual credit on KNOQRA Cloud', () => {
  it('stays open on a self-hosted instance and in Cloud development and tests', () => {
    expect(manualCreditAllowed({ KNOQRA_EDITION: 'selfhost', APP_ENV: 'production' })).toBe(true);
    expect(manualCreditAllowed({ APP_ENV: 'staging' })).toBe(true);
    expect(manualCreditAllowed({ KNOQRA_EDITION: 'cloud', APP_ENV: 'development' })).toBe(true);
    expect(manualCreditAllowed({ KNOQRA_EDITION: 'cloud', APP_ENV: 'test' })).toBe(true);
  });

  it('refuses it in Cloud staging and production: credit comes only from payments', async () => {
    expect(manualCreditAllowed({ KNOQRA_EDITION: 'cloud', APP_ENV: 'staging' })).toBe(false);
    expect(manualCreditAllowed({ KNOQRA_EDITION: 'cloud', APP_ENV: 'production' })).toBe(false);
    const cookie = await signUp(uniqueEmail('wallet-cloud-credit'));
    const orgId = await orgOf(cookie);
    const app = new OpenAPIHono<AppEnv>();
    app.use('/api/v1/*', requestDb, requestAuth, tenant());
    app.route('/', walletRoutes);
    const ctx = createExecutionContext();
    const response = await app.request(
      '/api/v1/wallet/credits',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          amountMicros: 1_000_000_000,
          note: 'Free money',
          idempotencyKey: 'cloud-credit-1',
        }),
      },
      { ...env, KNOQRA_EDITION: 'cloud', APP_ENV: 'staging' } as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('forbidden');
    const denied = await withAdminDb((db) =>
      db.select().from(auditEvent).where(eq(auditEvent.organizationId, orgId)),
    );
    expect(
      denied.some(
        (row) =>
          row.action === 'wallet.credit.create' &&
          row.outcome === 'denied' &&
          (row.metadata as { reason?: string } | null)?.reason === 'edition',
      ),
    ).toBe(true);
  });
});

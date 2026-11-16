import { env } from 'cloudflare:workers';
import { providerEventRaw } from '@knoqra/db';
import { FakeProvider } from '@knoqra/providers';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { logger } from '../src/lib/logger';
import { handleProviderEvents } from '../src/queue/consumer';
import { adapterFor, ingestWebhook, WEBHOOK_MAX_BYTES } from '../src/routes/webhooks';
import { api, withAdminDb } from './helpers';

/*
 * Queue spy choice: tests that count queue sends call `ingestWebhook(spyEnv, ...)` directly, where
 * `spyEnv` is the real test env with `PROVIDER_EVENTS` replaced by a recording double. The HTTP
 * route (SELF.fetch) cannot be given a double, because the Worker runs with its own bindings. The
 * HTTP tests therefore assert status codes, envelopes and stored rows, and the send-counting
 * tests assert exactly-once behavior on the same code path (the route is a thin wrapper).
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Sent = { rawEventId: string };

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });

function newSpy(opts: { failFirst?: boolean } = {}) {
  const sent: Sent[] = [];
  let shouldFail = opts.failFirst === true;
  const queue = {
    send: async (message: Sent) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('queue unavailable');
      }
      sent.push(message);
    },
  };
  return { sent, env: { ...env, PROVIDER_EVENTS: queue } as unknown as Env };
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function fakeEventBody(id: string): string {
  return JSON.stringify({
    id,
    type: 'call.answered',
    occurred_at: '2026-11-11T10:00:02.000Z',
    resource_id: 'call_1',
    payload: { note: 'hello' },
  });
}

function postWebhook(body: string, signature: string, provider = 'fake'): Promise<Response> {
  return api(`/webhooks/${provider}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-signature': signature },
    body,
  });
}

function rowsFor(externalEventId: string) {
  return withAdminDb((db) =>
    db
      .select()
      .from(providerEventRaw)
      .where(
        and(
          eq(providerEventRaw.provider, 'fake'),
          eq(providerEventRaw.externalEventId, externalEventId),
        ),
      ),
  );
}

async function countAllRaw(): Promise<number> {
  const rows = await withAdminDb((db) =>
    db.select({ n: sql<number>`count(*)::int` }).from(providerEventRaw),
  );
  return rows[0]?.n ?? 0;
}

function ingest(spyEnv: Env, body: string, signature: string) {
  return ingestWebhook(
    spyEnv,
    fake,
    new Headers({ 'x-fake-signature': signature }),
    new TextEncoder().encode(body),
  );
}

function unknownTypeBody(id: string): string {
  return JSON.stringify({
    id,
    type: 'call.exploded',
    occurred_at: '2026-11-11T10:00:02.000Z',
    resource_id: 'call_1',
    payload: {},
  });
}

describe('POST /webhooks/:provider', () => {
  it('acknowledges an unknown event type as ignored, with no row and no send', async () => {
    const id = uid('ev_ign');
    const body = unknownTypeBody(id);
    const sig = await fake.signWebhook(body);
    const r = await postWebhook(body, sig);
    expect(r.status).toBe(200);
    expect((await r.json()) as Envelope<unknown>).toEqual({
      data: { received: true, ignored: true },
      error: null,
    });
    expect(await rowsFor(id)).toHaveLength(0);
    const spy = newSpy();
    expect(await ingest(spy.env, body, sig)).toEqual({ status: 200, ignored: true });
    expect(spy.sent).toHaveLength(0);
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it('logs an ignored event at debug with only provider and a capped eventType', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const longType = `x${'y'.repeat(300)}`;
      const body = JSON.stringify({
        id: uid('ev_log'),
        type: longType,
        occurred_at: '2026-11-11T10:00:02.000Z',
        resource_id: 'call_1',
        payload: {},
      });
      await ingest(newSpy().env, body, await fake.signWebhook(body));
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith('webhook.ignored', {
        provider: 'fake',
        eventType: longType.slice(0, 100),
      });
    } finally {
      debug.mockRestore();
    }
  });

  it('stores new events as pending', async () => {
    const id = uid('ev_pend');
    const body = fakeEventBody(id);
    await postWebhook(body, await fake.signWebhook(body));
    expect((await rowsFor(id))[0]?.status).toBe('pending');
  });

  it('accepts a signed event once and stores it', async () => {
    const id = uid('ev_one');
    const body = fakeEventBody(id);
    const r = await postWebhook(body, await fake.signWebhook(body));
    expect(r.status).toBe(200);
    expect((await r.json()) as Envelope<{ received: boolean; duplicate: boolean }>).toEqual({
      data: { received: true, duplicate: false },
      error: null,
    });
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe('call.answered');
    expect(rows[0]?.body).toMatchObject({ id, resource_id: 'call_1' });
  });

  it('reports a repeated delivery as duplicate and keeps one row', async () => {
    const id = uid('ev_rep');
    const body = fakeEventBody(id);
    const sig = await fake.signWebhook(body);
    await postWebhook(body, sig);
    const again = await postWebhook(body, sig);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Envelope<{ duplicate: boolean }>).data?.duplicate).toBe(true);
    expect(await rowsFor(id)).toHaveLength(1);
  });

  it('401 invalid_signature on a bad signature, nothing stored', async () => {
    const body = fakeEventBody(uid('ev_bad'));
    const before = await countAllRaw();
    const r = await postWebhook(body, 'deadbeef');
    expect(r.status).toBe(401);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('invalid_signature');
    expect(await countAllRaw()).toBe(before);
  });

  it('401 when the signature header is missing', async () => {
    const r = await api('/webhooks/fake', { method: 'POST', body: fakeEventBody(uid('ev_nosig')) });
    expect(r.status).toBe(401);
  });

  it('400 invalid_payload on a signed non-JSON body, nothing stored', async () => {
    const before = await countAllRaw();
    const r = await postWebhook('not json', await fake.signWebhook('not json'));
    expect(r.status).toBe(400);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('invalid_payload');
    expect(await countAllRaw()).toBe(before);
  });

  it('404 not_found envelope for an unknown provider', async () => {
    const body = fakeEventBody(uid('ev_unk'));
    const r = await postWebhook(body, await fake.signWebhook(body), 'telnyx');
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
  });
});

describe('fake provider availability', () => {
  it('404s a correctly signed fake webhook in production and stores nothing', async () => {
    const id = uid('ev_prod');
    const body = fakeEventBody(id);
    const before = await countAllRaw();
    // SELF.fetch runs the Worker with its own bindings, so call the app with an env override.
    const productionEnv = { ...env, APP_ENV: 'production' } as unknown as Env;
    const r = await app.request(
      '/webhooks/fake',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fake-signature': await fake.signWebhook(body),
        },
        body,
      },
      productionEnv,
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
    expect(await rowsFor(id)).toHaveLength(0);
    expect(await countAllRaw()).toBe(before);
  });

  it('adapterFor is unavailable without a secret, and in production', () => {
    expect(adapterFor('fake', env)).not.toBeNull();
    expect(adapterFor('fake', { ...env, FAKE_WEBHOOK_SECRET: undefined } as Env)).toBeNull();
    expect(adapterFor('fake', { ...env, APP_ENV: 'production' } as Env)).toBeNull();
    expect(adapterFor('telnyx', env)).toBeNull();
  });
});

describe('telnyx provider availability', () => {
  it('404s /webhooks/telnyx when TELNYX_PUBLIC_KEY is unset', async () => {
    const r = await app.request(
      '/webhooks/telnyx',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env as unknown as Env,
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
  });

  it('adapterFor returns a telnyx adapter once the public key is set', () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const adapter = adapterFor('telnyx', { ...env, TELNYX_PUBLIC_KEY: key } as Env);
    expect(adapter?.provider).toBe('telnyx');
  });
});

describe('webhook body limit', () => {
  it('413 payload_too_large above 256 KB, nothing stored', async () => {
    const before = await countAllRaw();
    const body = 'x'.repeat(WEBHOOK_MAX_BYTES + 1);
    const r = await postWebhook(body, await fake.signWebhook(body));
    expect(r.status).toBe(413);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('payload_too_large');
    expect(await countAllRaw()).toBe(before);
  });
});

describe('ingestWebhook queueing', () => {
  it('queues a new event once', async () => {
    const id = uid('ev_q1');
    const body = fakeEventBody(id);
    const spy = newSpy();
    const result = await ingest(spy.env, body, await fake.signWebhook(body));
    expect(result).toMatchObject({ status: 200, duplicate: false });
    const rows = await rowsFor(id);
    expect(spy.sent).toEqual([{ rawEventId: rows[0]?.id }]);
  });

  it('concurrent duplicate deliveries store one row and enqueue once', async () => {
    const id = uid('ev_dup');
    const body = fakeEventBody(id);
    const sig = await fake.signWebhook(body);
    const spy = newSpy();
    const results = await Promise.all([1, 2, 3].map(() => ingest(spy.env, body, sig)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(results.filter((r) => 'duplicate' in r && !r.duplicate)).toHaveLength(1);
    expect(await rowsFor(id)).toHaveLength(1);
    expect(spy.sent).toHaveLength(1);
  });

  it('does not queue bad signatures or bad payloads', async () => {
    const spy = newSpy();
    const body = fakeEventBody(uid('ev_nq'));
    expect(await ingest(spy.env, body, 'deadbeef')).toMatchObject({ status: 401 });
    expect(await ingest(spy.env, 'not json', await fake.signWebhook('not json'))).toMatchObject({
      status: 400,
    });
    expect(spy.sent).toHaveLength(0);
  });

  it('a queue failure surfaces, and the provider retry re-sends an orphaned row', async () => {
    const id = uid('ev_orphan');
    const body = fakeEventBody(id);
    const sig = await fake.signWebhook(body);
    const flaky = newSpy({ failFirst: true });
    await expect(ingest(flaky.env, body, sig)).rejects.toThrow('queue unavailable');
    expect(await rowsFor(id)).toHaveLength(1);
    expect(flaky.sent).toHaveLength(0);

    // Inside the 60 s window the first attempt may still be in flight: do not send again.
    const early = await ingest(flaky.env, body, sig);
    expect(early).toMatchObject({ status: 200, duplicate: true });
    expect(flaky.sent).toHaveLength(0);

    // Past the window the row is treated as orphaned and re-enqueued.
    await withAdminDb((db) =>
      db
        .update(providerEventRaw)
        .set({ receivedAt: sql`now() - interval '2 minutes'` })
        .where(eq(providerEventRaw.externalEventId, id)),
    );
    const retry = await ingest(flaky.env, body, sig);
    expect(retry).toMatchObject({ status: 200, duplicate: true });
    expect(flaky.sent).toHaveLength(1);
  });

  it('does not re-send an old duplicate that was already processed', async () => {
    const id = uid('ev_done');
    const body = fakeEventBody(id);
    const sig = await fake.signWebhook(body);
    const spy = newSpy();
    await ingest(spy.env, body, sig);
    await withAdminDb((db) =>
      db
        .update(providerEventRaw)
        .set({ receivedAt: sql`now() - interval '2 minutes'`, processedAt: sql`now()` })
        .where(eq(providerEventRaw.externalEventId, id)),
    );
    expect(await ingest(spy.env, body, sig)).toMatchObject({ status: 200, duplicate: true });
    expect(spy.sent).toHaveLength(1);
  });
});

describe('handleProviderEvents', () => {
  function fakeBatch(ids: string[]) {
    const acked: string[] = [];
    const retried: string[] = [];
    const batch = {
      queue: 'knoqra-provider-events',
      messages: ids.map((rawEventId) => ({
        id: rawEventId,
        timestamp: new Date(),
        attempts: 1,
        body: { rawEventId },
        ack: () => acked.push(rawEventId),
        retry: () => retried.push(rawEventId),
      })),
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<{ rawEventId: string }>;
    return { batch, acked, retried };
  }

  it('marks events processed idempotently and acks every delivery', async () => {
    const id = uid('ev_cons');
    const body = fakeEventBody(id);
    const spy = newSpy();
    await ingest(spy.env, body, await fake.signWebhook(body));
    const rawEventId = spy.sent[0]?.rawEventId as string;

    const first = fakeBatch([rawEventId]);
    await handleProviderEvents(first.batch, env);
    const processedAt = (await rowsFor(id))[0]?.processedAt;
    expect(processedAt).toBeInstanceOf(Date);
    expect(first.acked).toEqual([rawEventId]);

    const second = fakeBatch([rawEventId]);
    await handleProviderEvents(second.batch, env);
    expect((await rowsFor(id))[0]?.processedAt).toEqual(processedAt);
    expect(second.acked).toEqual([rawEventId]);
    expect(second.retried).toEqual([]);
  });

  it('retries messages when the database fails, without throwing', async () => {
    const broken = { ...env, DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' } as Env;
    const b = fakeBatch(['pe_missing']);
    await handleProviderEvents(b.batch, broken);
    expect(b.retried).toEqual(['pe_missing']);
    expect(b.acked).toEqual([]);
  });
});

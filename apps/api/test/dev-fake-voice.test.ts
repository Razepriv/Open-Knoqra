import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { providerEventRaw } from '@knoqra/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { api, get, post, signUp, uniqueEmail, withAdminDb } from './helpers';

/*
 * The dev routes enqueue onto PROVIDER_EVENTS. Requests go through `app.request` with a recording
 * queue double, so the raw row is observed before any consumer touches it.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type User = { cookie: string; orgId: string };
type Sent = { rawEventId: string };

async function newUser(label: string): Promise<User> {
  const cookie = await signUp(uniqueEmail(label));
  const body = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = body.data?.organization.id;
  if (!orgId) throw new Error('no active organization');
  return { cookie, orgId };
}

async function dial(u: User): Promise<string> {
  const contact = await post('/api/v1/contacts', u.cookie, {
    displayName: 'Dev Caller',
    phone: '+12025550123',
  });
  const contactId = ((await contact.json()) as Envelope<{ id: string }>).data?.id;
  const put = await api(`/api/v1/contacts/${contactId}/permissions/manual_call`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: u.cookie },
    body: JSON.stringify({ status: 'granted' }),
  });
  expect(put.status).toBe(200);
  const r = await post('/api/v1/calls', u.cookie, {
    contactId,
    idempotencyKey: `dev-${crypto.randomUUID()}`,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as Envelope<{ call: { id: string } }>).data?.call.id as string;
}

function spyEnv(overrides: Partial<Env> = {}) {
  const sent: Sent[] = [];
  const queue = { send: async (m: Sent) => void sent.push(m) };
  return { sent, env: { ...env, PROVIDER_EVENTS: queue, ...overrides } as unknown as Env };
}

/** `app.request` with the given bindings and a real execution context (requestDb uses waitUntil). */
async function request(path: string, cookie: string, body: unknown, bindings: Env) {
  const ctx = createExecutionContext();
  const response = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    },
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const rawRow = async (id: string) =>
  (
    await withAdminDb((db) => db.select().from(providerEventRaw).where(eq(providerEventRaw.id, id)))
  )[0];

describe('POST /api/v1/dev/fake-voice/calls/{id}/events', () => {
  it('404 in production', async () => {
    const u = await newUser('dev-prod');
    const callId = await dial(u);
    const spy = spyEnv({ APP_ENV: 'production' });
    const r = await request(
      `/api/v1/dev/fake-voice/calls/${callId}/events`,
      u.cookie,
      { event: 'answered' },
      spy.env,
    );
    expect(r.status).toBe(404);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
    expect(spy.sent).toEqual([]);
  });

  it('404 before body validation in production, and without the fake webhook secret', async () => {
    const u = await newUser('dev-gate');
    const callId = await dial(u);
    const gated: Partial<Env>[] = [{ APP_ENV: 'production' }, { FAKE_WEBHOOK_SECRET: undefined }];
    for (const overrides of gated) {
      const r = await request(
        `/api/v1/dev/fake-voice/calls/${callId}/events`,
        u.cookie,
        { event: 'not-an-event' },
        spyEnv(overrides).env,
      );
      expect(r.status).toBe(404);
      const inbound = await request(
        '/api/v1/dev/fake-voice/inbound',
        u.cookie,
        { scenario: 'nope' },
        spyEnv(overrides).env,
      );
      expect(inbound.status).toBe(404);
    }
  });

  it("404 for another organization's call", async () => {
    const a = await newUser('dev-org-a');
    const b = await newUser('dev-org-b');
    const callId = await dial(a);
    const spy = spyEnv();
    const r = await request(
      `/api/v1/dev/fake-voice/calls/${callId}/events`,
      b.cookie,
      { event: 'answered' },
      spy.env,
    );
    expect(r.status).toBe(404);
    expect(spy.sent).toEqual([]);
  });

  it('202 for a valid request, with a pending raw row carrying the call client state', async () => {
    const u = await newUser('dev-valid');
    const callId = await dial(u);
    const spy = spyEnv();
    const r = await request(
      `/api/v1/dev/fake-voice/calls/${callId}/events`,
      u.cookie,
      { event: 'completed', billableSeconds: 61 },
      spy.env,
    );
    expect(r.status).toBe(202);
    expect(spy.sent).toHaveLength(1);
    const raw = await rawRow(spy.sent[0]?.rawEventId as string);
    expect(raw).toMatchObject({ provider: 'fake', eventType: 'call.completed', status: 'pending' });
    expect(raw?.body).toMatchObject({
      type: 'call.completed',
      payload: { direction: 'outbound', billable_seconds: 61 },
    });
  });

  it('400 for an unknown event', async () => {
    const u = await newUser('dev-bad');
    const callId = await dial(u);
    const r = await request(
      `/api/v1/dev/fake-voice/calls/${callId}/events`,
      u.cookie,
      { event: 'exploded' },
      spyEnv().env,
    );
    expect(r.status).toBe(400);
  });
});

describe('POST /api/v1/dev/fake-voice/inbound', () => {
  it('404 in production', async () => {
    const u = await newUser('dev-in-prod');
    const spy = spyEnv({ APP_ENV: 'production' });
    const r = await request(
      '/api/v1/dev/fake-voice/inbound',
      u.cookie,
      { from: '+12025550142', scenario: 'ring' },
      spy.env,
    );
    expect(r.status).toBe(404);
    expect(spy.sent).toEqual([]);
  });

  it('202 with a provider call id; voicemail sends a second event', async () => {
    const u = await newUser('dev-in');
    const spy = spyEnv();
    const r = await request(
      '/api/v1/dev/fake-voice/inbound',
      u.cookie,
      { from: '+12025550142', scenario: 'voicemail' },
      spy.env,
    );
    expect(r.status).toBe(202);
    const body = (await r.json()) as Envelope<{ providerCallId: string }>;
    expect(body.data?.providerCallId).toMatch(/^fake_in_[0-9a-f]{32}$/);
    expect(spy.sent).toHaveLength(2);
    const first = await rawRow(spy.sent[0]?.rawEventId as string);
    expect(first).toMatchObject({ eventType: 'call.initiated', status: 'pending' });
    expect(first?.body).toMatchObject({
      resource_id: body.data?.providerCallId,
      payload: {
        direction: 'inbound',
        from: '+12025550142',
        to: '+12025550100',
        org_id: u.orgId,
      },
    });
    const second = await rawRow(spy.sent[1]?.rawEventId as string);
    expect(second?.body).toMatchObject({
      type: 'call.voicemail',
      payload: {
        duration_seconds: 22,
        transcript: "Hi, it's about Thursday's review. Call me back.",
      },
    });
  });

  it('422 for an invalid number', async () => {
    const u = await newUser('dev-in-bad');
    const r = await request(
      '/api/v1/dev/fake-voice/inbound',
      u.cookie,
      { from: 'not a phone', scenario: 'ring' },
      spyEnv().env,
    );
    expect(r.status).toBe(422);
  });
});

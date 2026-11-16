import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { auditEvent, call, callEvent, member, providerNumberRoute, session } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { api, get, post, signUp, uniqueEmail, withAdminDb } from './helpers';

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };
type Check = {
  id: string;
  status: string;
  detail: string;
  fix: { kind: string; step?: string } | null;
};
type SetupJson = {
  steps: { id: string; done: boolean }[];
  currentStep: string | null;
  lastStep: string | null;
  dismissedAt: string | null;
  completedAt: string | null;
  checks: Check[];
};
type Org = { cookie: string; orgId: string; userId: string };

const API_KEY = 'KEY0TESTONLY1234567890abcdef';
const CALLER_ID = '+12025550100';

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

const getSetup = async (cookie: string) => {
  const r = await get('/api/v1/setup', cookie);
  expect(r.status).toBe(200);
  return ((await r.json()) as Envelope<SetupJson>).data as SetupJson;
};

const patchSetup = (cookie: string, body: unknown) =>
  api('/api/v1/setup', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

const stepDone = (s: SetupJson, id: string) => s.steps.find((x) => x.id === id)?.done;
const check = (s: SetupJson, id: string) => {
  const found = s.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

async function connect(cookie: string) {
  await withAdminDb((db) =>
    db.delete(providerNumberRoute).where(eq(providerNumberRoute.e164, CALLER_ID)),
  );
  const r = await api('/api/v1/voice/connection', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ apiKey: API_KEY, connectionId: '1234567890', callerIdE164: CALLER_ID }),
  });
  expect(r.status).toBe(200);
}

async function syncAndAssign(cookie: string) {
  const r = await post('/api/v1/numbers/sync', cookie, {});
  expect(r.status).toBe(200);
  const items = ((await r.json()) as Envelope<{ items: { id: string }[] }>).data?.items ?? [];
  const p = await api(`/api/v1/numbers/${items[0]?.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ assignedUse: 'calls' }),
  });
  expect(p.status).toBe(200);
}

async function dial(u: Org): Promise<string> {
  const contact = await post('/api/v1/contacts', u.cookie, {
    displayName: 'Setup Caller',
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
    idempotencyKey: `setup-${crypto.randomUUID()}`,
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as Envelope<{ call: { id: string } }>).data?.call.id as string;
}

/** A completed call plus the signal that completed it (fixture; the pipeline has its own tests). */
async function completedCall(u: Org): Promise<string> {
  const id = await dial(u);
  await withAdminDb(async (db) => {
    await db.update(call).set({ state: 'completed' }).where(eq(call.id, id));
    await db.insert(callEvent).values({
      organizationId: u.orgId,
      callId: id,
      rawEventId: `raw_${crypto.randomUUID()}`,
      signal: 'hangup',
      stateBefore: 'connected',
      stateAfter: 'completed',
    });
  });
  return id;
}

describe('GET /api/v1/setup', () => {
  it('401 without a session', async () => {
    expect((await get('/api/v1/setup')).status).toBe(401);
  });

  it('a new org has nothing done and credential and number checks failing', async () => {
    const u = await newOrg('setup-new');
    const s = await getSetup(u.cookie);
    expect(s.steps.map((x) => x.id)).toEqual(['connect', 'number', 'audio', 'test_call']);
    expect(s.steps.every((x) => !x.done)).toBe(true);
    expect(s.currentStep).toBe('connect');
    expect(s).toMatchObject({ lastStep: null, dismissedAt: null, completedAt: null });
    expect(check(s, 'credential').status).toBe('fail');
    expect(check(s, 'number').status).toBe('fail');
  });

  it('connecting marks connect done; the fake provider passes the credential check', async () => {
    const u = await newOrg('setup-connect');
    await connect(u.cookie);
    const s = await getSetup(u.cookie);
    expect(stepDone(s, 'connect')).toBe(true);
    expect(s.currentStep).toBe('number');
    const cred = check(s, 'credential');
    expect(cred.status).toBe('pass');
    expect(cred.detail).toContain('fake provider');
  });

  it('sync and assign mark number done, ten_dlc pass and whatsapp pending (fake WhatsApp number)', async () => {
    const u = await newOrg('setup-number');
    await connect(u.cookie);
    await syncAndAssign(u.cookie);
    const s = await getSetup(u.cookie);
    expect(stepDone(s, 'number')).toBe(true);
    expect(s.currentStep).toBe('audio');
    expect(check(s, 'number').status).toBe('pass');
    expect(check(s, 'ten_dlc').status).toBe('pass');
    expect(check(s, 'whatsapp').status).toBe('pending');
  });
});

describe('PATCH /api/v1/setup', () => {
  it('audioChecked marks audio done and audits', async () => {
    const u = await newOrg('setup-audio');
    const r = await patchSetup(u.cookie, { audioChecked: true, lastStep: 'audio' });
    expect(r.status).toBe(200);
    const s = ((await r.json()) as Envelope<SetupJson>).data as SetupJson;
    expect(stepDone(s, 'audio')).toBe(true);
    expect(s.lastStep).toBe('audio');
    const audits = await withAdminDb((db) =>
      db
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.organizationId, u.orgId), eq(auditEvent.action, 'setup.update'))),
    );
    expect(audits.map((a) => a.outcome)).toEqual(['allowed']);
  });

  it('a completed call as testCallId completes setup and passes the webhook check', async () => {
    const u = await newOrg('setup-test-call');
    await connect(u.cookie);
    await syncAndAssign(u.cookie);
    await patchSetup(u.cookie, { audioChecked: true });
    const callId = await completedCall(u);
    const r = await patchSetup(u.cookie, { testCallId: callId });
    expect(r.status).toBe(200);
    const s = ((await r.json()) as Envelope<SetupJson>).data as SetupJson;
    expect(stepDone(s, 'test_call')).toBe(true);
    expect(s.currentStep).toBeNull();
    expect(s.completedAt).not.toBeNull();
    expect(check(s, 'webhook').status).toBe('pass');
  });

  it('409 invalid_state for a canceled call', async () => {
    const u = await newOrg('setup-canceled');
    const callId = await dial(u);
    await withAdminDb((db) =>
      db.update(call).set({ state: 'canceled' }).where(eq(call.id, callId)),
    );
    const r = await patchSetup(u.cookie, { testCallId: callId });
    expect(r.status).toBe(409);
    expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('invalid_state');
    expect(stepDone(await getSetup(u.cookie), 'test_call')).toBe(false);
  });

  it('404 for another organization call, a missing call and a malformed id', async () => {
    const a = await newOrg('setup-org-a');
    const b = await newOrg('setup-org-b');
    const foreign = await completedCall(b);
    for (const id of [foreign, `cl_${'0'.repeat(32)}`, 'nope']) {
      const r = await patchSetup(a.cookie, { testCallId: id });
      expect(r.status).toBe(404);
      expect(((await r.json()) as Envelope<unknown>).error?.code).toBe('not_found');
    }
  });

  it('dismissed round trip', async () => {
    const u = await newOrg('setup-dismiss');
    const on = (
      (await (await patchSetup(u.cookie, { dismissed: true })).json()) as Envelope<SetupJson>
    ).data;
    expect(on?.dismissedAt).not.toBeNull();
    const off = (
      (await (await patchSetup(u.cookie, { dismissed: false })).json()) as Envelope<SetupJson>
    ).data;
    expect(off?.dismissedAt).toBeNull();
  });

  it('400 for an invalid body', async () => {
    const u = await newOrg('setup-bad');
    expect((await patchSetup(u.cookie, { lastStep: 'bogus' })).status).toBe(400);
  });
});

describe('setup checks and per-user progress', () => {
  it('telnyx without TELNYX_PUBLIC_KEY fails the webhook check with an external fix', async () => {
    const u = await newOrg('setup-telnyx');
    await connect(u.cookie);
    const ctx = createExecutionContext();
    const bindings = { ...env, PROVIDER: 'telnyx', TELNYX_PUBLIC_KEY: undefined } as unknown as Env;
    const response = await app.request(
      '/api/v1/setup',
      { headers: { cookie: u.cookie } },
      bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const s = ((await response.json()) as Envelope<SetupJson>).data as SetupJson;
    const webhook = check(s, 'webhook');
    expect(webhook.status).toBe('fail');
    expect(webhook.fix?.kind).toBe('external');
  });

  it('progress is per user: a second member sees their own audio state', async () => {
    const owner = await newOrg('setup-owner');
    await patchSetup(owner.cookie, { audioChecked: true });
    const other = await newOrg('setup-member');
    await withAdminDb(async (db) => {
      await db.insert(member).values({
        id: `mem_${crypto.randomUUID()}`,
        organizationId: owner.orgId,
        userId: other.userId,
        role: 'member',
        createdAt: new Date(),
      });
      await db
        .update(session)
        .set({ activeOrganizationId: owner.orgId })
        .where(eq(session.userId, other.userId));
    });
    expect(stepDone(await getSetup(owner.cookie), 'audio')).toBe(true);
    expect(stepDone(await getSetup(other.cookie), 'audio')).toBe(false);
  });
});

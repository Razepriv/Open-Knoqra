import { env } from 'cloudflare:workers';
import { type Tx, withTenant } from '@knoqra/db';
import {
  FakeProvider,
  fakeMessageEvent,
  type MessageEventPayload,
  type ProviderEventType,
  toFakeWebhookBody,
} from '@knoqra/providers';
import { expect, vi } from 'vitest';
import type { Env } from '../src/env';
import { handleProviderEvents } from '../src/queue/consumer';
import { ingestWebhook } from '../src/routes/webhooks';
import { api, get, post, signUp, uniqueEmail, withAppDb } from './helpers';

export type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

export interface MessagingOrg {
  cookie: string;
  orgId: string;
  userId: string;
  smsAddress: string;
  whatsappAddress: string;
}

export interface MessagingThread {
  contactId: string;
  conversationId: string;
  phone: string;
}

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });

export function put(path: string, cookie: string, body: unknown) {
  return api(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

export async function data<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Envelope<T>;
  if (body.data === null)
    throw new Error(`no data: ${response.status} ${JSON.stringify(body.error)}`);
  return body.data;
}

/** A signed-up owner with sandbox senders on both channels. */
export async function sandboxOrg(label: string, status = 'approved'): Promise<MessagingOrg> {
  const cookie = await signUp(uniqueEmail(label), `Owner ${label}`);
  const me = await data<{ user: { id: string }; organization: { id: string } }>(
    await get('/api/v1/me', cookie),
  );
  expect(
    (await put('/api/v1/messaging/sandbox', cookie, { sms: status, whatsapp: status })).status,
  ).toBe(200);
  const senders = await data<{ items: Array<{ channel: string; address: string }> }>(
    await get('/api/v1/messaging/senders', cookie),
  );
  const address = (channel: string) =>
    senders.items.find((s) => s.channel === channel)?.address as string;
  return {
    cookie,
    orgId: me.organization.id,
    userId: me.user.id,
    smsAddress: address('sms'),
    whatsappAddress: address('whatsapp'),
  };
}

let phoneCounter = 0;
/** A reserved 555-01xx number, unique enough per test run and organization. */
export function testPhone(): string {
  phoneCounter = (phoneCounter + 1) % 100;
  return `+1202555${String(100 + phoneCounter).padStart(4, '0')}`;
}

/** A contact with consent on the channel and its conversation. */
export async function consentedThread(
  org: MessagingOrg,
  channel: 'sms' | 'whatsapp',
  phone = testPhone(),
): Promise<MessagingThread> {
  const contact = await data<{ id: string }>(
    await post('/api/v1/contacts', org.cookie, { displayName: 'Sam Rivera', phone }),
  );
  const granted = await put(`/api/v1/contacts/${contact.id}/permissions/${channel}`, org.cookie, {
    status: 'granted',
    evidence: 'Agreed in person',
  });
  expect(granted.status).toBe(200);
  const conv = await data<{ id: string }>(
    await post('/api/v1/conversations', org.cookie, { contactId: contact.id, channel }),
  );
  return { contactId: contact.id, conversationId: conv.id, phone };
}

export const tenantTx = <T>(org: MessagingOrg, fn: (tx: Tx) => Promise<T>) =>
  withAppDb((db) => withTenant(db, org.orgId, fn));

export const tenantOf = (org: MessagingOrg) => ({
  orgId: org.orgId,
  userId: org.userId,
  role: 'owner',
});

/** Stores one fake provider event through the webhook and runs it through the queue consumer. */
export async function deliverFakeEvent(
  type: ProviderEventType,
  providerMessageId: string,
  payload: MessageEventPayload,
  opts: { env?: Env } = {},
): Promise<void> {
  const body = toFakeWebhookBody(fakeMessageEvent({ type, providerMessageId, payload }));
  const queued: string[] = [];
  const spyEnv = {
    ...env,
    PROVIDER_EVENTS: { send: async (m: { rawEventId: string }) => void queued.push(m.rawEventId) },
  } as unknown as Env;
  const headers = new Headers({ 'x-fake-signature': await fake.signWebhook(body) });
  expect((await ingestWebhook(spyEnv, fake, headers, new TextEncoder().encode(body))).status).toBe(
    200,
  );
  const msg = { body: { rawEventId: queued[0] as string }, ack: vi.fn(), retry: vi.fn() };
  await handleProviderEvents(
    { messages: [msg] } as unknown as MessageBatch<{ rawEventId: string }>,
    (opts.env ?? env) as Env,
  );
  expect(msg.ack).toHaveBeenCalledTimes(1);
}

/** Polls `read` until `done` holds (background work after a response), or fails after ~5 s. */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let last: T = await read();
  for (let i = 0; i < 100 && !done(last); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    last = await read();
  }
  if (!done(last)) throw new Error(`condition not met: ${JSON.stringify(last)}`);
  return last;
}

import { env } from 'cloudflare:workers';
import { channelConnection, channelRoute, withTenant } from '@knoqra/db';
import {
  FakeProvider,
  fakeMessageEvent,
  type MessageEventPayload,
  toFakeWebhookBody,
} from '@knoqra/providers';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { type ReceivedMessageEvent, withExtensions } from '../src/extensions';
import { handleProviderEvents } from '../src/queue/consumer';
import { ingestWebhook } from '../src/routes/webhooks';
import { get, signUp, uniqueEmail, withAppDb } from './helpers';

/*
 * The `afterMessageReceived` extension hook: called once per new inbound message, after commit,
 * and never for a duplicate delivery, a receipt or a reaction. A failing hook changes nothing.
 */

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

const fake = new FakeProvider({ webhookSecret: env.FAKE_WEBHOOK_SECRET as string });
const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

async function setupOrg(): Promise<{ orgId: string; address: string }> {
  const cookie = await signUp(uniqueEmail('received-hook'));
  const me = (await (await get('/api/v1/me', cookie)).json()) as Envelope<{
    organization: { id: string };
  }>;
  const orgId = me.data?.organization.id as string;
  const address = `sandbox:${hex(8)}`;
  await withAppDb((db) =>
    withTenant(db, orgId, async (tx) => {
      const [conn] = await tx
        .insert(channelConnection)
        .values({ organizationId: orgId, channel: 'sms', provider: 'fake', address })
        .returning();
      if (!conn) throw new Error('connection insert failed');
      await tx.insert(channelRoute).values({
        organizationId: orgId,
        provider: 'fake',
        channel: 'sms',
        address,
        connectionId: conn.id,
      });
    }),
  );
  return { orgId, address };
}

async function deliverAndProcess(hookEnv: Env, body: string): Promise<void> {
  const sent: string[] = [];
  const queueEnv = {
    ...env,
    PROVIDER_EVENTS: { send: async (m: { rawEventId: string }) => void sent.push(m.rawEventId) },
  } as unknown as Env;
  const headers = new Headers({ 'x-fake-signature': await fake.signWebhook(body) });
  const result = await ingestWebhook(queueEnv, fake, headers, new TextEncoder().encode(body));
  expect(result.status).toBe(200);
  const rawEventId = sent[0];
  if (!rawEventId) return;
  const batch = {
    queue: 'knoqra-provider-events',
    messages: [
      {
        id: rawEventId,
        timestamp: new Date(),
        attempts: 1,
        body: { rawEventId },
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<{ rawEventId: string }>;
  await handleProviderEvents(batch, hookEnv);
}

function inbound(
  address: string,
  providerMessageId: string,
  payload: Partial<MessageEventPayload>,
) {
  return toFakeWebhookBody(
    fakeMessageEvent({
      type: 'message.received',
      providerMessageId,
      payload: { channel: 'sms', from: '+12025550142', to: address, ...payload },
    }),
  );
}

describe('afterMessageReceived', () => {
  it('runs once for a new inbound message, not for duplicates, receipts or reactions', async () => {
    const org = await setupOrg();
    const seen: ReceivedMessageEvent[] = [];
    const hookEnv = withExtensions(env as unknown as Env, [
      { name: 'spy', afterMessageReceived: async (_env, event) => void seen.push(event) },
    ]);
    const pmid = `pm_${hex(8)}`;
    await deliverAndProcess(hookEnv, inbound(org.address, pmid, { body: 'Hello there' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: org.orgId, channel: 'sms' });
    expect(seen[0]?.messageId).toMatch(/^mg_/);
    expect(seen[0]?.conversationId).toBeTruthy();
    expect(seen[0]?.contactId).toBeTruthy();

    // The same message delivered again (a new event id, the same provider message id).
    await deliverAndProcess(hookEnv, inbound(org.address, pmid, { body: 'Hello there' }));
    expect(seen).toHaveLength(1);

    // A reaction to it.
    await deliverAndProcess(
      hookEnv,
      inbound(org.address, `pm_${hex(8)}`, { reaction: { targetId: pmid, emoji: '👍' } }),
    );
    expect(seen).toHaveLength(1);

    // A delivery receipt for an outbound message.
    await deliverAndProcess(
      hookEnv,
      toFakeWebhookBody(
        fakeMessageEvent({
          type: 'message.delivered',
          providerMessageId: `pm_${hex(8)}`,
          payload: { channel: 'sms', from: org.address, to: '+12025550142' },
        }),
      ),
    );
    expect(seen).toHaveLength(1);
  });

  it('logs and swallows a failing hook', async () => {
    const org = await setupOrg();
    const hookEnv = withExtensions(env as unknown as Env, [
      {
        name: 'broken',
        afterMessageReceived: async () => {
          throw new Error('hook failed');
        },
      },
    ]);
    await expect(
      deliverAndProcess(hookEnv, inbound(org.address, `pm_${hex(8)}`, { body: 'Still stored' })),
    ).resolves.toBeUndefined();
  });
});

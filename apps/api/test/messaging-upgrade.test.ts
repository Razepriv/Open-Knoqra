import { env } from 'cloudflare:workers';
import { conversation, message, messageAttachment, messageReaction } from '@knoqra/db';
import type {
  AuthorizedWhatsAppReaction,
  AuthorizedWhatsAppRequest,
  MessagingProvider,
} from '@knoqra/providers';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { setReaction } from '../src/messaging/reactions';
import { dispatchMessage, sendMessage } from '../src/messaging/send';
import { insertMessage } from '../src/messaging/store';
import { get, withAppDb } from './helpers';
import {
  consentedThread,
  data,
  deliverFakeEvent,
  type MessagingOrg,
  type MessagingThread,
  sandboxOrg,
  tenantOf,
  tenantTx,
} from './messaging-helpers';

type Msg = {
  id: string;
  status: string;
  providerMessageId: string | null;
  clientMessageId: string | null;
  replyTo: { id: string; body: string } | null;
  reactions: Array<{ emoji: string; direction: string; status: string }>;
  attachments: Array<{ kind: string; status: string; url: string | null }>;
  replyable: boolean;
};

/** A provider that records every call and accepts it. */
function recordingProvider() {
  const sends: AuthorizedWhatsAppRequest[] = [];
  const reactions: AuthorizedWhatsAppReaction[] = [];
  const id = () => `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`;
  const provider: MessagingProvider = {
    sendSms: async () => ({ providerMessageId: id(), state: 'queued' }),
    sendWhatsApp: async (input) => {
      sends.push(input);
      return { providerMessageId: id(), state: 'queued' };
    },
    sendWhatsAppReaction: async (input) => {
      reactions.push(input);
      return { providerMessageId: id(), state: 'queued' };
    },
  };
  return { provider, sends, reactions };
}

/** An inbound WhatsApp message with a wamid, which opens the window and can be replied to. */
async function inboundWhatsApp(org: MessagingOrg, t: MessagingThread, body = 'Is it fixed?') {
  const wamid = `wamid.${crypto.randomUUID().replaceAll('-', '')}`;
  const row = await tenantTx(org, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversation)
      .where(eq(conversation.id, t.conversationId));
    if (!conv) throw new Error('no conversation');
    return insertMessage(tx, {
      orgId: org.orgId,
      conversation: conv,
      direction: 'inbound',
      body,
      status: 'received',
      provider: 'fake',
      providerMessageId: `pm_${crypto.randomUUID().replaceAll('-', '')}`,
      occurredAt: new Date(),
      channelMessageId: wamid,
    });
  });
  return { id: row.id, wamid };
}

let org: MessagingOrg;
beforeAll(async () => {
  org = await sandboxOrg('upgrade');
});

describe('instant send', () => {
  it('answers with the queued message before the provider is called, then sends it', async () => {
    const t = await consentedThread(org, 'sms');
    const tasks: Promise<unknown>[] = [];
    let called = 0;
    const provider: MessagingProvider = {
      sendSms: async () => {
        called += 1;
        return {
          providerMessageId: `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`,
          state: 'queued',
        };
      },
      sendWhatsApp: async () => {
        throw new Error('not used');
      },
    };
    const clientMessageId = crypto.randomUUID();
    const result = await withAppDb((db) =>
      sendMessage(
        { db, env, tenant: tenantOf(org), provider, background: (task) => void tasks.push(task) },
        t.conversationId,
        { clientMessageId, body: 'On my way' },
      ),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(result.message).toMatchObject({
      status: 'queued',
      providerMessageId: null,
      clientMessageId,
    });
    expect(called).toBe(0);
    await Promise.all(tasks);
    expect(called).toBe(1);
    const after = await data<Msg>(await get(`/api/v1/messages/${result.message.id}`, org.cookie));
    expect(after.providerMessageId).toMatch(/^fake_msg_/);
  });

  it('calls the provider once when two workers dispatch the same message', async () => {
    const t = await consentedThread(org, 'sms');
    const tasks: Promise<unknown>[] = [];
    let called = 0;
    const provider: MessagingProvider = {
      sendSms: async () => {
        called += 1;
        await new Promise((r) => setTimeout(r, 20));
        return {
          providerMessageId: `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`,
          state: 'queued',
        };
      },
      sendWhatsApp: async () => {
        throw new Error('not used');
      },
    };
    const result = await withAppDb((db) =>
      sendMessage(
        // Hold the background send so both "workers" race on a still-unclaimed message.
        { db, env, tenant: tenantOf(org), provider, background: (task) => void tasks.push(task) },
        t.conversationId,
        { clientMessageId: crypto.randomUUID(), body: 'Twice?' },
      ),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    const deps = { env, orgId: org.orgId, provider };
    const [a, b] = await Promise.all([
      dispatchMessage(deps, result.message.id),
      dispatchMessage(deps, result.message.id),
      ...tasks,
    ]);
    expect(called).toBe(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe('replies', () => {
  it('quotes an inbound WhatsApp message by its wamid and shows the quote', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const inbound = await inboundWhatsApp(org, t, 'Which part?');
    const { provider, sends } = recordingProvider();
    const result = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(org), provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'The left hinge',
        replyToMessageId: inbound.id,
      }),
    );
    if (result.kind !== 'created') throw new Error(`unexpected ${result.kind}`);
    expect(sends[0]?.replyTo).toBe(inbound.wamid);
    expect(result.message.replyTo).toMatchObject({ id: inbound.id, body: 'Which part?' });
  });

  it('refuses to quote an outbound message, or one from another conversation', async () => {
    const t = await consentedThread(org, 'whatsapp');
    await inboundWhatsApp(org, t);
    const { provider } = recordingProvider();
    const first = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(org), provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Mine',
      }),
    );
    if (first.kind !== 'created') throw new Error(`unexpected ${first.kind}`);
    const own = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(org), provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Quoting myself',
        replyToMessageId: first.message.id,
      }),
    );
    expect(own).toMatchObject({ kind: 'error', status: 422 });
    const elsewhere = await consentedThread(org, 'whatsapp');
    const foreign = await inboundWhatsApp(org, elsewhere);
    const cross = await withAppDb((db) =>
      sendMessage({ db, env, tenant: tenantOf(org), provider }, t.conversationId, {
        clientMessageId: crypto.randomUUID(),
        body: 'Wrong thread',
        replyToMessageId: foreign.id,
      }),
    );
    expect(cross).toMatchObject({ kind: 'error', status: 404 });
  });
});

describe('reactions', () => {
  it('sends a reaction to the wamid, records it sent, and removes it', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const inbound = await inboundWhatsApp(org, t);
    const { provider, reactions } = recordingProvider();
    const set = await withAppDb((db) =>
      setReaction({ db, env, tenant: tenantOf(org), provider }, inbound.id, '👍'),
    );
    if (set.kind !== 'ok') throw new Error(`unexpected ${set.kind}`);
    expect(reactions[0]).toMatchObject({
      targetChannelMessageId: inbound.wamid,
      emoji: '👍',
      to: t.phone,
    });
    expect(set.message.reactions).toEqual([{ emoji: '👍', direction: 'outbound', status: 'sent' }]);

    const removed = await withAppDb((db) =>
      setReaction({ db, env, tenant: tenantOf(org), provider }, inbound.id, ''),
    );
    if (removed.kind !== 'ok') throw new Error(`unexpected ${removed.kind}`);
    expect(reactions[1]?.emoji).toBe('');
    expect(removed.message.reactions).toEqual([]);
  });

  it('marks a reaction failed when the provider refuses it', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const inbound = await inboundWhatsApp(org, t);
    const provider: MessagingProvider = {
      ...recordingProvider().provider,
      sendWhatsAppReaction: async () => {
        throw new Error('upstream 500');
      },
    };
    const result = await withAppDb((db) =>
      setReaction({ db, env, tenant: tenantOf(org), provider }, inbound.id, '❤️'),
    );
    if (result.kind !== 'ok') throw new Error(`unexpected ${result.kind}`);
    expect(result.message.reactions).toMatchObject([{ emoji: '❤️', status: 'failed' }]);
  });

  it('refuses text, outbound targets and a closed window', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const inbound = await inboundWhatsApp(org, t);
    const { provider } = recordingProvider();
    const text = await withAppDb((db) =>
      setReaction({ db, env, tenant: tenantOf(org), provider }, inbound.id, 'ok'),
    );
    expect(text).toMatchObject({ kind: 'error', status: 422 });
    const closed = await consentedThread(org, 'whatsapp');
    const old = await inboundWhatsApp(org, closed);
    await tenantTx(org, (tx) =>
      tx
        .update(conversation)
        .set({ lastInboundAt: new Date(Date.now() - 2 * 86_400_000) })
        .where(eq(conversation.id, closed.conversationId)),
    );
    const late = await withAppDb((db) =>
      setReaction({ db, env, tenant: tenantOf(org), provider }, old.id, '👍'),
    );
    expect(late).toMatchObject({ kind: 'error', status: 422, code: 'template_required' });
  });
});

describe('inbound WhatsApp media, reactions and replies', () => {
  it('stores an inbound image as a pending attachment with its caption', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const providerMessageId = `fake_in_${crypto.randomUUID().replaceAll('-', '')}`;
    await deliverFakeEvent('message.received', providerMessageId, {
      channel: 'whatsapp',
      from: t.phone,
      to: org.whatsappAddress,
      body: 'The broken part',
      media: { kind: 'image', mimeType: 'image/jpeg', url: 'https://media.example.test/x' },
      channelMessageId: 'wamid.inbound-image',
    });
    const [row] = await tenantTx(org, (tx) =>
      tx.select().from(message).where(eq(message.providerMessageId, providerMessageId)),
    );
    expect(row).toMatchObject({ body: 'The broken part', channelMessageId: 'wamid.inbound-image' });
    const files = await tenantTx(org, (tx) =>
      tx
        .select()
        .from(messageAttachment)
        .where(eq(messageAttachment.messageId, row?.id as string)),
    );
    expect(files).toMatchObject([
      { kind: 'image', status: 'pending', sourceUrl: 'https://media.example.test/x' },
    ]);
    const conv = await data<{ lastMessagePreview: string }>(
      await get(`/api/v1/conversations/${t.conversationId}`, org.cookie),
    );
    expect(conv.lastMessagePreview).toBe('Photo: The broken part');
  });

  it('lands a contact reaction on its target and resolves a reply by wamid', async () => {
    const t = await consentedThread(org, 'whatsapp');
    const target = await inboundWhatsApp(org, t, 'First');
    await deliverFakeEvent(
      'message.received',
      `fake_in_${crypto.randomUUID().replaceAll('-', '')}`,
      {
        channel: 'whatsapp',
        from: t.phone,
        to: org.whatsappAddress,
        reaction: { targetId: target.wamid, emoji: '😂' },
      },
    );
    const reactions = await tenantTx(org, (tx) =>
      tx
        .select()
        .from(messageReaction)
        .where(
          and(eq(messageReaction.messageId, target.id), eq(messageReaction.direction, 'inbound')),
        ),
    );
    expect(reactions).toMatchObject([{ emoji: '😂' }]);

    const replyId = `fake_in_${crypto.randomUUID().replaceAll('-', '')}`;
    await deliverFakeEvent('message.received', replyId, {
      channel: 'whatsapp',
      from: t.phone,
      to: org.whatsappAddress,
      body: 'About this one',
      replyToId: target.wamid,
    });
    const [reply] = await tenantTx(org, (tx) =>
      tx.select().from(message).where(eq(message.providerMessageId, replyId)),
    );
    expect(reply?.replyToMessageId).toBe(target.id);

    await deliverFakeEvent(
      'message.received',
      `fake_in_${crypto.randomUUID().replaceAll('-', '')}`,
      {
        channel: 'whatsapp',
        from: t.phone,
        to: org.whatsappAddress,
        reaction: { targetId: target.wamid, emoji: null },
      },
    );
    const after = await tenantTx(org, (tx) =>
      tx.select().from(messageReaction).where(eq(messageReaction.messageId, target.id)),
    );
    expect(after).toHaveLength(0);
  });
});

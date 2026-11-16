import { describe, expect, it } from 'vitest';
import {
  failOptimistic,
  isOptimistic,
  type Message,
  optimisticMessage,
  removeOptimistic,
  type ThreadData,
  updateThreadMessage,
  upsertThreadMessage,
  withOwnReaction,
} from './inbox-cache';
import { FALLBACK_POLL_MS, pollWhileOffline } from './realtime-status';

const base = (patch: Partial<Message> = {}): Message => ({
  id: 'mg_1',
  conversationId: 'cv_1',
  channel: 'whatsapp',
  direction: 'outbound',
  body: 'Hi',
  templateId: null,
  templateName: null,
  status: 'queued',
  error: null,
  authorUserId: 'u_1',
  providerMessageId: null,
  clientMessageId: 'c-1',
  occurredAt: '2026-11-16T10:00:00.000Z',
  statusUpdatedAt: '2026-11-16T10:00:00.000Z',
  attachments: [],
  reactions: [],
  replyTo: null,
  replyable: false,
  ...patch,
});

const thread = (...messages: Message[]): ThreadData => ({
  pages: [
    { items: messages.map((message) => ({ kind: 'message' as const, message })), nextCursor: null },
  ],
  pageParams: [undefined],
});

const ids = (data: ThreadData | undefined) =>
  data?.pages.flatMap((p) =>
    p.items.map((i) => (i.kind === 'message' ? `${i.message.id}:${i.message.status}` : i.note.id)),
  );

describe('optimistic sends', () => {
  it('shows the message at once, newest first, then swaps in the server row by clientMessageId', () => {
    const older = base({
      id: 'mg_0',
      clientMessageId: null,
      occurredAt: '2026-11-16T09:00:00.000Z',
      status: 'read',
    });
    const optimistic = optimisticMessage({
      conversationId: 'cv_1',
      channel: 'whatsapp',
      clientMessageId: 'c-1',
      body: 'On my way',
      authorUserId: 'u_1',
      now: new Date('2026-11-16T10:00:00.000Z'),
    });
    expect(isOptimistic(optimistic)).toBe(true);
    expect(optimistic).toMatchObject({ status: 'queued', id: 'tmp_c-1', clientMessageId: 'c-1' });
    const shown = upsertThreadMessage(thread(older), optimistic);
    expect(ids(shown)).toEqual(['tmp_c-1:queued', 'mg_0:read']);
    const server = base({ body: 'On my way' });
    expect(ids(upsertThreadMessage(shown, server))).toEqual(['mg_1:queued', 'mg_0:read']);
  });

  it('marks a send that never reached the server failed, or removes a refused one', () => {
    const optimistic = optimisticMessage({
      conversationId: 'cv_1',
      channel: 'sms',
      clientMessageId: 'c-9',
      authorUserId: null,
      now: new Date(),
    });
    const data = thread(optimistic);
    const failed = failOptimistic(data, 'c-9', 'We could not send this message. Try again.');
    expect(failed?.pages[0]?.items[0]).toMatchObject({
      message: { status: 'failed', error: { code: 'not_sent' } },
    });
    expect(ids(removeOptimistic(data, 'c-9'))).toEqual([]);
  });
});

describe('realtime updates', () => {
  it('moves a message forward but never back', () => {
    const data = thread(base({ status: 'delivered' }));
    expect(ids(upsertThreadMessage(data, base({ status: 'read' })))).toEqual(['mg_1:read']);
    expect(ids(upsertThreadMessage(data, base({ status: 'sent' })))).toEqual(['mg_1:delivered']);
    // A stale status still brings a newer reaction along.
    const reacted = upsertThreadMessage(
      data,
      base({ status: 'sent', reactions: [{ emoji: '👍', direction: 'inbound', status: 'sent' }] }),
    );
    expect(reacted?.pages[0]?.items[0]).toMatchObject({
      message: { status: 'delivered', reactions: [{ emoji: '👍' }] },
    });
  });

  it('adds an inbound message in time order, and leaves an unloaded thread alone', () => {
    const data = thread(
      base({
        id: 'mg_2',
        clientMessageId: null,
        occurredAt: '2026-11-16T12:00:00.000Z',
        status: 'sent',
      }),
      base({ status: 'sent' }),
    );
    const inbound = base({
      id: 'mg_3',
      clientMessageId: null,
      direction: 'inbound',
      status: 'received',
      occurredAt: '2026-11-16T11:00:00.000Z',
    });
    expect(ids(upsertThreadMessage(data, inbound))).toEqual([
      'mg_2:sent',
      'mg_3:received',
      'mg_1:sent',
    ]);
    expect(upsertThreadMessage(undefined, inbound)).toBeUndefined();
  });

  it('sets and removes the workspace reaction locally', () => {
    const theirs = { emoji: '😂', direction: 'inbound' as const, status: 'sent' as const };
    const message = base({ reactions: [theirs] });
    expect(withOwnReaction(message, '👍').reactions).toEqual([
      theirs,
      { emoji: '👍', direction: 'outbound', status: 'pending' },
    ]);
    expect(withOwnReaction(withOwnReaction(message, '👍'), '').reactions).toEqual([theirs]);
    const data = updateThreadMessage(
      thread(message),
      (m) => m.id === 'mg_1',
      (m) => withOwnReaction(m, '❤️'),
    );
    expect(data?.pages[0]?.items[0]).toMatchObject({
      message: { reactions: [theirs, { emoji: '❤️' }] },
    });
  });
});

describe('pollWhileOffline', () => {
  it('stops polling while the realtime socket is open', () => {
    expect(pollWhileOffline('open')).toBe(false);
    expect(pollWhileOffline('closed')).toBe(FALLBACK_POLL_MS);
    expect(pollWhileOffline('connecting')).toBe(FALLBACK_POLL_MS);
  });
});

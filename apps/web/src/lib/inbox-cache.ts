import type { components } from '@knoqra/api-client';
import type { InfiniteData } from '@tanstack/react-query';

// Pure helpers that keep the thread cache in step with sends and realtime frames, so the Inbox
// shows a message the moment it is sent and every status change as it happens, with no polling.

export type Message = components['schemas']['Message'];
export type ThreadItem = components['schemas']['ThreadItem'];
export type ThreadPage = components['schemas']['ThreadPage'];
export type ThreadData = InfiniteData<ThreadPage, string | undefined>;
export type Attachment = components['schemas']['MessageAttachment'];

/** The id an optimistic copy carries until the server's row replaces it. */
export const optimisticId = (clientMessageId: string): string => `tmp_${clientMessageId}`;
export const isOptimistic = (message: Pick<Message, 'id'>): boolean =>
  message.id.startsWith('tmp_');

const messageOf = (item: ThreadItem): Message | null =>
  item.kind === 'message' ? item.message : null;

/** Whether `incoming` is the same message as `cached`: same id, or the server row of an optimistic copy. */
function sameMessage(cached: Message, incoming: Message): boolean {
  if (cached.id === incoming.id) return true;
  return (
    incoming.clientMessageId !== null &&
    cached.clientMessageId === incoming.clientMessageId &&
    isOptimistic(cached)
  );
}

/** Status order, so a late frame never moves a message back (queued → sent → delivered → read). */
const RANK: Record<Message['status'], number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
  received: 4,
};

/** Keeps the further-along of two copies of one message; equal ranks take the newer copy. */
function newer(cached: Message, incoming: Message): Message {
  if (isOptimistic(cached)) return incoming;
  if (RANK[incoming.status] < RANK[cached.status]) {
    // A stale status, but files, reactions and the quote may still have moved on.
    return {
      ...cached,
      attachments: incoming.attachments,
      reactions: incoming.reactions,
      replyTo: incoming.replyTo,
    };
  }
  return incoming;
}

/**
 * Puts a message into the thread: replaces its copy (by id, or an optimistic copy by its
 * clientMessageId), or adds it to the newest page in occurredAt order. Pages are newest first.
 * Without a cached thread, nothing is written (the thread loads it when opened).
 */
export function upsertThreadMessage(
  data: ThreadData | undefined,
  incoming: Message,
): ThreadData | undefined {
  if (!data) return data;
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      const cached = messageOf(item);
      if (!cached || found || !sameMessage(cached, incoming)) return item;
      found = true;
      return { kind: 'message' as const, message: newer(cached, incoming) };
    }),
  }));
  if (found) return { ...data, pages };
  const [first, ...rest] = pages;
  if (!first) {
    return {
      ...data,
      pages: [{ items: [{ kind: 'message', message: incoming }], nextCursor: null }],
    };
  }
  const at = first.items.findIndex((item) => {
    const when = item.kind === 'message' ? item.message.occurredAt : item.note.occurredAt;
    return when <= incoming.occurredAt;
  });
  const items = [...first.items];
  items.splice(at === -1 ? items.length : at, 0, { kind: 'message', message: incoming });
  return { ...data, pages: [{ ...first, items }, ...rest] };
}

/** Changes the cached message with this id (or optimistic clientMessageId), if any. */
export function updateThreadMessage(
  data: ThreadData | undefined,
  match: (message: Message) => boolean,
  change: (message: Message) => Message,
): ThreadData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.kind === 'message' && match(item.message)
          ? { kind: 'message' as const, message: change(item.message) }
          : item,
      ),
    })),
  };
}

/** Removes an optimistic copy (a send the server refused outright). */
export function removeOptimistic(
  data: ThreadData | undefined,
  clientMessageId: string,
): ThreadData | undefined {
  if (!data) return data;
  const id = optimisticId(clientMessageId);
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.kind !== 'message' || item.message.id !== id),
    })),
  };
}

export interface OptimisticInput {
  conversationId: string;
  channel: Message['channel'];
  clientMessageId: string;
  body?: string | undefined;
  attachment?: Attachment | undefined;
  replyTo?: Message['replyTo'] | undefined;
  authorUserId: string | null;
  now: Date;
}

/** The message the Desk shows while a send is on its way ("Sending…"). */
export function optimisticMessage(input: OptimisticInput): Message {
  const at = input.now.toISOString();
  return {
    id: optimisticId(input.clientMessageId),
    conversationId: input.conversationId,
    channel: input.channel,
    direction: 'outbound',
    body: input.body ?? '',
    templateId: null,
    templateName: null,
    status: 'queued',
    error: null,
    authorUserId: input.authorUserId,
    providerMessageId: null,
    clientMessageId: input.clientMessageId,
    occurredAt: at,
    statusUpdatedAt: at,
    attachments: input.attachment ? [input.attachment] : [],
    reactions: [],
    replyTo: input.replyTo ?? null,
    replyable: false,
  };
}

/** Marks an optimistic copy failed with our wording, so it can be retried or removed. */
export function failOptimistic(
  data: ThreadData | undefined,
  clientMessageId: string,
  message: string,
): ThreadData | undefined {
  const id = optimisticId(clientMessageId);
  return updateThreadMessage(
    data,
    (m) => m.id === id,
    (m) => ({ ...m, status: 'failed', error: { code: 'not_sent', message } }),
  );
}

/** The workspace's own reaction on a message, set (or, with '', removed) at once. */
export function withOwnReaction(message: Message, emoji: string): Message {
  const others = message.reactions.filter((r) => r.direction !== 'outbound');
  return {
    ...message,
    reactions:
      emoji === '' ? others : [...others, { emoji, direction: 'outbound', status: 'pending' }],
  };
}

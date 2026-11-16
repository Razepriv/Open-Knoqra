import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { postFakeEvent } from './fake-webhooks';

export type MessagingChannel = 'sms' | 'whatsapp';
export type Registration = 'approved' | 'pending' | 'not_started' | 'rejected';

export interface Sender {
  channel: MessagingChannel;
  address: string;
  registrationStatus: Registration;
  sandbox: boolean;
}

export interface Senders {
  sms: Sender;
  whatsapp: Sender;
}

interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string } | null;
}

async function dataOf<T>(response: {
  status(): number;
  ok(): boolean;
  json(): Promise<unknown>;
}): Promise<T> {
  const body = (await response.json()) as Envelope<T>;
  expect(response.ok(), JSON.stringify(body.error)).toBe(true);
  if (body.data === null) throw new Error('The API answered without data.');
  return body.data;
}

/**
 * Phones from the reserved `+1 202 555 01xx` range, in E.164. Each call returns a fresh pool that
 * starts at a random number, so the numbers within one test never repeat.
 */
export function phonePool(): () => string {
  let next = Math.floor(Math.random() * 100);
  let handed = 0;
  return () => {
    if (handed >= 100) throw new Error('phonePool: the 555-01xx range is used up.');
    const phone = `+1202555${String(100 + (next % 100)).padStart(4, '0')}`;
    next += 1;
    handed += 1;
    return phone;
  };
}

/** Sets the organization's sandbox senders; returns them by channel. */
export async function setSandbox(
  page: Page,
  sms: Registration,
  whatsapp: Registration,
): Promise<Senders> {
  const data = await dataOf<{ items: Sender[] }>(
    await page.request.put('/api/v1/messaging/sandbox', { data: { sms, whatsapp } }),
  );
  const pick = (channel: MessagingChannel) => {
    const sender = data.items.find((item) => item.channel === channel);
    if (!sender) throw new Error(`No ${channel} sandbox sender came back.`);
    return sender;
  };
  return { sms: pick('sms'), whatsapp: pick('whatsapp') };
}

export interface CreatedContact {
  id: string;
  displayName: string;
  phoneE164: string;
}

export async function createContactApi(
  page: Page,
  name: string,
  phone: string,
): Promise<CreatedContact> {
  return dataOf<CreatedContact>(
    await page.request.post('/api/v1/contacts', { data: { displayName: name, phone } }),
  );
}

export async function grantConsent(
  page: Page,
  contactId: string,
  channel: MessagingChannel,
): Promise<void> {
  await dataOf(
    await page.request.put(`/api/v1/contacts/${contactId}/permissions/${channel}`, {
      data: { status: 'granted', evidence: 'Agreed on the phone.' },
    }),
  );
}

/** A message from the contact (`from`) to our sandbox sender (`to`). */
export async function inbound(
  page: Page,
  input: {
    channel: MessagingChannel;
    to: string;
    from: string;
    body: string;
    occurredAt?: string;
  },
): Promise<void> {
  await postFakeEvent(page.request, {
    type: 'message.received',
    resourceId: `fake_in_${randomUUID().replaceAll('-', '')}`,
    payload: { channel: input.channel, from: input.from, to: input.to, body: input.body },
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

export type ReceiptStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * A delivery receipt for one of our messages: `from` is our sandbox sender. `to` is the contact;
 * the API does not route receipts by it, so it defaults to a reserved number.
 */
export async function receipt(
  page: Page,
  input: {
    channel: MessagingChannel;
    from: string;
    to?: string;
    providerMessageId: string;
    status: ReceiptStatus;
    error?: { code: string; message: string };
  },
): Promise<void> {
  await postFakeEvent(page.request, {
    type: `message.${input.status}`,
    resourceId: input.providerMessageId,
    payload: {
      channel: input.channel,
      from: input.from,
      to: input.to ?? '+12025550100',
      ...(input.error ? { error: input.error } : {}),
    },
  });
}

interface ThreadItem {
  kind: 'message' | 'note';
  message?: { body: string; direction: string; providerMessageId: string | null; status: string };
}

/** The provider's id for our latest outbound message with this body, as the API stores it. */
export async function providerMessageIdFor(
  page: Page,
  conversationId: string,
  body: string,
): Promise<string> {
  const data = await dataOf<{ items: ThreadItem[] }>(
    await page.request.get(`/api/v1/conversations/${conversationId}/items`),
  );
  const found = data.items.find(
    (item) => item.message?.direction === 'outbound' && item.message.body === body,
  );
  const id = found?.message?.providerMessageId;
  if (!id) throw new Error('No provider message id for that outbound message.');
  return id;
}

/** The `thread` id from an `/inbox?thread=` address, once the Inbox has opened one. */
export async function openThreadId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/inbox\?(.*&)?thread=[^&]+/, ARRIVES);
  const id = new URL(page.url()).searchParams.get('thread');
  if (!id) throw new Error('No thread is open.');
  return id;
}

/** Opens (or creates) the contact's conversation on a channel, as a Contact 360 link does. */
export async function openInbox(
  page: Page,
  contactId: string,
  channel: MessagingChannel,
): Promise<string> {
  await page.goto(`/inbox?contact=${contactId}&channel=${channel}`);
  return openThreadId(page);
}

export const conversationPane = (page: Page): Locator =>
  page.getByLabel('Conversation', { exact: true });

/** The bubble (message or note) in the open thread whose text includes `text`. */
export const bubble = (page: Page, text: string): Locator =>
  conversationPane(page).getByRole('listitem').filter({ hasText: text });

/** The meta line under a bubble: time, status and, for templates, the template name. */
export const bubbleMeta = (item: Locator): Locator => item.locator('p').last();

/**
 * The composer's state card (paused, blocked, templates only): the first status in the Reply
 * panel. Loading skeletons are statuses too, but they only ever come after the card.
 */
export const composerStatus = (page: Page): Locator =>
  conversationPane(page).getByRole('tabpanel', { name: 'Reply' }).getByRole('status').first();

export const messageBox = (page: Page): Locator =>
  conversationPane(page).getByRole('textbox', { name: 'Message' });

/** The open conversation's row in the thread list. */
export const threadRow = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: 'Conversations' }).getByRole('button').filter({ hasText: name });

/** Effects of a webhook land after the queue and the next poll: wait longer than `expect`'s 5 s. */
export const ARRIVES = { timeout: 15_000 };

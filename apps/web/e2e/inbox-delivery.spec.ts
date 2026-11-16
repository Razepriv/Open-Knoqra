import { expect, test } from '@playwright/test';
import { timeline } from './contact-helpers';
import {
  ARRIVES,
  bubble,
  bubbleMeta,
  conversationPane,
  createContactApi,
  grantConsent,
  inbound,
  messageBox,
  openThreadId,
  phonePool,
  providerMessageIdFor,
  receipt,
  setSandbox,
} from './inbox-helpers';
import { signUp } from './session';

// Every webhook takes a queue hop and a poll (a few seconds) to show, so these flows run long.
test.slow();

const TIME = '\\d{2}:\\d{2}';
const meta = (status: string) => new RegExp(`^${TIME} · ${status}$`);

test('an SMS opened from Contact 360 goes from sending to delivered, and a failure says why', async ({
  page,
}) => {
  await signUp(page);
  const senders = await setSandbox(page, 'approved', 'approved');
  const phone = phonePool()();
  const contact = await createContactApi(page, 'Rosa Diaz', phone);
  await grantConsent(page, contact.id, 'sms');

  // Contact 360's SMS pill opens the thread in the Inbox.
  await page.goto(`/contacts/${contact.id}`);
  await page.getByRole('link', { name: 'SMS', exact: true }).click();
  const conversationId = await openThreadId(page);
  await expect(conversationPane(page).getByRole('heading', { name: 'Rosa Diaz' })).toBeVisible(
    ARRIVES,
  );

  const first = 'Your quote is ready.';
  await messageBox(page).fill(first);
  await conversationPane(page).getByRole('button', { name: 'Send' }).click();
  await expect(messageBox(page)).toHaveValue('', ARRIVES);
  const sent = bubble(page, first);
  await expect(bubbleMeta(sent)).toHaveText(meta('SENDING…'));

  const firstId = await providerMessageIdFor(page, conversationId, first);
  const from = senders.sms.address;
  await receipt(page, {
    channel: 'sms',
    from,
    to: phone,
    providerMessageId: firstId,
    status: 'sent',
  });
  await expect(bubbleMeta(sent)).toHaveText(meta('SENT'), ARRIVES);
  await receipt(page, {
    channel: 'sms',
    from,
    to: phone,
    providerMessageId: firstId,
    status: 'delivered',
  });
  await expect(bubbleMeta(sent)).toHaveText(meta('DELIVERED'), ARRIVES);

  const second = 'Are you free on Thursday?';
  await messageBox(page).fill(second);
  await conversationPane(page).getByRole('button', { name: 'Send' }).click();
  const failing = bubble(page, second);
  await expect(bubbleMeta(failing)).toHaveText(meta('SENDING…'));
  await receipt(page, {
    channel: 'sms',
    from,
    to: phone,
    providerMessageId: await providerMessageIdFor(page, conversationId, second),
    status: 'failed',
    error: { code: '30003', message: 'Unreachable handset' },
  });
  await expect(bubbleMeta(failing)).toHaveText(meta('FAILED · Unreachable handset'), ARRIVES);
  // The first message keeps its own status.
  await expect(bubbleMeta(sent)).toHaveText(meta('DELIVERED'));

  // The contact's timeline lists the outbound SMS under Messages.
  await page.goto(`/contacts/${contact.id}`);
  await timeline(page).getByRole('button', { name: 'Messages' }).click();
  await expect(timeline(page).getByText('Outbound SMS', { exact: true }).first()).toBeVisible(
    ARRIVES,
  );
});

test('a WhatsApp reply inside the window goes all the way to read', async ({ page }) => {
  await signUp(page);
  const senders = await setSandbox(page, 'approved', 'approved');
  const phone = phonePool()();
  const contact = await createContactApi(page, 'Kofi Mensah', phone);
  await grantConsent(page, contact.id, 'whatsapp');
  const from = senders.whatsapp.address;
  await inbound(page, { channel: 'whatsapp', to: from, from: phone, body: 'Is the van free?' });

  await page.goto(`/contacts/${contact.id}`);
  await page.getByRole('link', { name: 'WhatsApp', exact: true }).click();
  const conversationId = await openThreadId(page);
  await expect(bubble(page, 'Is the van free?')).toBeVisible(ARRIVES);

  const reply = 'Yes, from 9 tomorrow.';
  await messageBox(page).fill(reply);
  await conversationPane(page).getByRole('button', { name: 'Send' }).click();
  const sent = bubble(page, reply);
  await expect(bubbleMeta(sent)).toHaveText(meta('SENDING…'));

  const providerMessageId = await providerMessageIdFor(page, conversationId, reply);
  for (const [status, text] of [
    ['sent', 'SENT'],
    ['delivered', 'DELIVERED'],
    ['read', 'READ'],
  ] as const) {
    await receipt(page, { channel: 'whatsapp', from, to: phone, providerMessageId, status });
    await expect(bubbleMeta(sent)).toHaveText(meta(text), ARRIVES);
  }
});

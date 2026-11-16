import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { timeline } from './contact-helpers';
import {
  ARRIVES,
  bubble,
  bubbleMeta,
  composerStatus,
  conversationPane,
  createContactApi,
  grantConsent,
  inbound,
  messageBox,
  openInbox,
  phonePool,
  setSandbox,
  threadRow,
} from './inbox-helpers';
import { signUp } from './session';

// Every webhook takes a queue hop and a poll (a few seconds) to show, so these flows run long.
test.slow();

const HOUR_MS = 60 * 60 * 1000;

test('a closed WhatsApp window allows only templates until the contact writes again', async ({
  page,
}) => {
  await signUp(page);
  const senders = await setSandbox(page, 'approved', 'approved');
  const phone = phonePool()();
  const contact = await createContactApi(page, 'Lena Hart', phone);
  await grantConsent(page, contact.id, 'whatsapp');
  const to = senders.whatsapp.address;
  await inbound(page, {
    channel: 'whatsapp',
    to,
    from: phone,
    body: 'Do you deliver on Sundays?',
    occurredAt: new Date(Date.now() - 25 * HOUR_MS).toISOString(),
  });

  await openInbox(page, contact.id, 'whatsapp');
  await expect(bubble(page, 'Do you deliver on Sundays?')).toBeVisible(ARRIVES);
  await expect(composerStatus(page)).toContainText('Window closed · templates only', ARRIVES);
  await expect(messageBox(page)).toHaveCount(0);
  const windowCard = page.getByRole('region', { name: 'WhatsApp window' });
  await expect(windowCard).toContainText(/closed/i);

  // No approved templates yet: create one from the composer, then pick it.
  await conversationPane(page).getByRole('button', { name: 'Manage templates' }).click();
  const dialog = page.getByRole('dialog', { name: 'Templates' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Follow up');
  await dialog.getByLabel('Channel').selectOption('whatsapp');
  await dialog.getByLabel('Body').fill('Hi {{first_name}}, following up on your question.');
  await dialog.getByRole('button', { name: 'Create template' }).click();
  await expect(dialog.getByText('Saved Follow up.')).toBeVisible(ARRIVES);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await conversationPane(page)
    .getByRole('radio', { name: /Follow up/ })
    .check();
  await conversationPane(page).getByRole('button', { name: 'Send template' }).click();
  const sent = bubble(page, 'Hi Lena, following up on your question.');
  await expect(bubbleMeta(sent)).toHaveText(/^TEMPLATE FOLLOW UP · \d{2}:\d{2} · SENDING…$/);

  // A new message from the contact opens the window again.
  await inbound(page, { channel: 'whatsapp', to, from: phone, body: 'Yes please, Sunday.' });
  await expect(messageBox(page)).toBeVisible(ARRIVES);
  await expect(windowCard).toContainText(/left/i, ARRIVES);
});

test('paused SMS sending keeps inbound arriving, and the API refuses to send', async ({ page }) => {
  await signUp(page);
  const senders = await setSandbox(page, 'pending', 'approved');
  const phone = phonePool()();
  const contact = await createContactApi(page, 'Omar Haddad', phone);
  await grantConsent(page, contact.id, 'sms');

  const conversationId = await openInbox(page, contact.id, 'sms');
  await expect(composerStatus(page)).toContainText('SMS sending paused · 10DLC', ARRIVES);
  await expect(conversationPane(page).getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(messageBox(page)).toHaveCount(0);

  const response = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, {
    data: { clientMessageId: randomUUID(), body: 'Trying anyway.' },
  });
  expect(response.status()).toBe(422);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('send_paused');

  await inbound(page, { channel: 'sms', to: senders.sms.address, from: phone, body: 'Hello?' });
  await expect(bubble(page, 'Hello?')).toBeVisible(ARRIVES);
  await expect(threadRow(page, 'Omar Haddad')).toContainText('Sending paused', ARRIVES);
});

test('an internal note stays in the team and shows on the contact timeline', async ({ page }) => {
  await signUp(page);
  await setSandbox(page, 'approved', 'approved');
  const contact = await createContactApi(page, 'Priya Nair', phonePool()());
  await grantConsent(page, contact.id, 'sms');

  await openInbox(page, contact.id, 'sms');
  await conversationPane(page).getByRole('tab', { name: 'Internal note' }).click();
  await conversationPane(page)
    .getByRole('textbox', { name: 'Note' })
    .fill('Finance approved terms');
  await conversationPane(page).getByRole('button', { name: 'Add note' }).click();
  const note = bubble(page, 'Finance approved terms');
  await expect(note).toBeVisible();
  await expect(note).toContainText('INTERNAL ONLY · NOT SENT');

  await page.goto(`/contacts/${contact.id}`);
  await expect(timeline(page).getByText('Finance approved terms')).toBeVisible(ARRIVES);
});

test('a contact without consent can be given it from the composer', async ({ page }) => {
  await signUp(page);
  await setSandbox(page, 'approved', 'approved');
  const contact = await createContactApi(page, 'Jonas Berg', phonePool()());

  await openInbox(page, contact.id, 'sms');
  await expect(composerStatus(page)).toContainText('Needs consent before messaging', ARRIVES);
  await expect(messageBox(page)).toHaveCount(0);

  await conversationPane(page).getByRole('button', { name: 'Record SMS consent' }).click();
  await page
    .getByRole('dialog', { name: 'Record that Jonas Berg agreed to receive SMS?' })
    .getByRole('button', { name: 'Record consent' })
    .click();
  await expect(messageBox(page)).toBeVisible(ARRIVES);
  await expect(composerStatus(page).filter({ hasText: 'Needs consent' })).toHaveCount(0, ARRIVES);
});

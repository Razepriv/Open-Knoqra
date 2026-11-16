import { expect, test } from '@playwright/test';
import { permissions } from './contact-helpers';
import {
  ARRIVES,
  bubble,
  composerStatus,
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

test('STOP blocks SMS until START, and do not contact outlasts START', async ({ page }) => {
  await signUp(page);
  const senders = await setSandbox(page, 'approved', 'approved');
  const phone = phonePool()();
  const contact = await createContactApi(page, 'Ada Kowalski', phone);
  await grantConsent(page, contact.id, 'sms');
  const reply = (body: string) =>
    inbound(page, { channel: 'sms', to: senders.sms.address, from: phone, body });

  await openInbox(page, contact.id, 'sms');
  await expect(messageBox(page)).toBeVisible(ARRIVES);

  await reply('Stop.');
  await expect(bubble(page, 'Stop.')).toBeVisible(ARRIVES);
  await expect(composerStatus(page)).toContainText('Opted out · messages blocked', ARRIVES);
  await expect(messageBox(page)).toHaveCount(0);
  await expect(threadRow(page, 'Ada Kowalski')).toContainText('Opted out', ARRIVES);

  // Contact 360 shows the same consent.
  await page.goto(`/contacts/${contact.id}`);
  const smsRow = permissions(page).getByRole('listitem').filter({ hasText: 'SMS' });
  await expect(smsRow).toContainText('Blocked', ARRIVES);
  await expect(smsRow).toContainText('Opted out', ARRIVES);

  await openInbox(page, contact.id, 'sms');
  await reply('START');
  await expect(bubble(page, 'START')).toBeVisible(ARRIVES);
  await expect(messageBox(page)).toBeVisible(ARRIVES);

  // Do not contact is policy: a later START does not lift it.
  await page.goto(`/contacts/${contact.id}`);
  await page.getByRole('button', { name: 'Change SMS consent' }).click();
  await page.getByRole('menuitem', { name: 'Do not contact' }).click();
  await page
    .getByRole('dialog', { name: 'Do not contact Ada Kowalski?' })
    .getByRole('button', { name: 'Mark do not contact' })
    .click();
  await expect(smsRow).toContainText('Do not contact. Policy, not a task.', ARRIVES);

  await openInbox(page, contact.id, 'sms');
  await expect(composerStatus(page)).toContainText('Do not contact · messages blocked', ARRIVES);
  await reply('START');
  await expect(bubble(page, 'START')).toHaveCount(2, ARRIVES);
  // Read the composer afresh, so it reflects consent after the START was applied.
  await page.reload();
  await expect(bubble(page, 'START')).toHaveCount(2, ARRIVES);
  await expect(composerStatus(page)).toContainText('Do not contact · messages blocked', ARRIVES);
  await expect(messageBox(page)).toHaveCount(0);
});

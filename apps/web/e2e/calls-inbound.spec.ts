import { expect, test } from '@playwright/test';
import {
  callState,
  callsPanel,
  createContact,
  dialer,
  fakeInbound,
  incomingDialog,
  liveCall,
  outcomeDialog,
  PIPELINE,
} from './call-helpers';
import { timeline } from './contact-helpers';
import { signUp } from './session';

// Inbound calls on the fake provider: the dev endpoint rings the workspace through the real
// webhook, queue and realtime pipeline. No fixed sleeps; state changes wait on that pipeline.
test.describe.configure({ timeout: 90_000 });

test('an inbound call rings, is answered, gets an outcome and shows on the timeline and in Recents', async ({
  page,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Priya Natarajan', '+1 202 555 0171');
  await page.goto('/calls');
  await expect(callsPanel(page).getByText(/^No calls yet/)).toBeVisible();

  await fakeInbound(page, '+12025550171', 'ring');
  const ringing = incomingDialog(page);
  await expect(ringing).toBeVisible(PIPELINE);
  await expect(ringing).toContainText('Priya Natarajan');
  await ringing.getByRole('button', { name: 'Answer' }).click();

  await expect(callState(page)).toHaveText('Connected', PIPELINE);
  await liveCall(page).getByRole('button', { name: 'Hang up' }).click();
  const outcome = outcomeDialog(page);
  await expect(outcome).toBeVisible(PIPELINE);
  await outcome.getByRole('radio', { name: 'Connected' }).check();
  await outcome.getByRole('button', { name: 'Save' }).click();
  await expect(outcome).toHaveCount(0);

  await page.goto(`/contacts/${id}`);
  await expect(
    timeline(page)
      .getByText(/^Inbound call/)
      .first(),
  ).toBeVisible(PIPELINE);
  await expect(timeline(page).getByText('Outcome: Connected')).toBeVisible();

  await page.goto('/calls');
  const row = callsPanel(page).getByRole('listitem').filter({ hasText: 'Priya Natarajan' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Completed');
  await expect(row.getByRole('img', { name: 'Inbound' })).toBeVisible();
  await expect(row).toContainText('Connected');
  await expect(row.getByRole('button', { name: 'Log outcome' })).toHaveCount(0);
});

test('a declined inbound call is listed without a Log outcome button', async ({ page }) => {
  await signUp(page);
  await createContact(page, 'Omar Haddad', '+1 202 555 0173');
  await page.goto('/calls');
  await fakeInbound(page, '+12025550173', 'ring');
  const ringing = incomingDialog(page);
  await expect(ringing).toBeVisible(PIPELINE);
  await ringing.getByRole('button', { name: 'Decline' }).click();
  await expect(ringing).toHaveCount(0);
  const row = callsPanel(page).getByRole('listitem').filter({ hasText: 'Omar Haddad' });
  await expect(row).toContainText('Missed', PIPELINE);
  await expect(row.getByRole('button', { name: 'Log outcome' })).toHaveCount(0);
});

test('an inbound voicemail shows on the Voicemail tab with its transcript until listened to', async ({
  page,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Maya Chen', '+1 202 555 0172');
  await page.goto('/calls');
  const tabs = callsPanel(page).getByRole('tablist', { name: 'Calls' });
  await expect(tabs.getByRole('tab', { name: 'Voicemail', exact: true })).toBeVisible();

  await fakeInbound(page, '+12025550172', 'voicemail');
  const tab = tabs.getByRole('tab', { name: 'Voicemail, 1 unread' });
  await expect(tab).toBeVisible(PIPELINE);
  await expect(tab).toContainText('1');
  await tab.click();

  const list = callsPanel(page).getByRole('list', { name: 'Voicemail' });
  const item = list.getByRole('listitem').filter({ hasText: 'Maya Chen' });
  await expect(item).toContainText('0:22');
  await expect(item).toContainText('Transcript may be inaccurate');
  await expect(item).toContainText("Hi, it's about Thursday's review. Call me back.");
  await expect(item).toContainText('Audio playback arrives with live Telnyx');
  await item.getByRole('button', { name: 'Mark listened' }).click();
  await expect(tabs.getByRole('tab', { name: 'Voicemail', exact: true })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Mark listened' })).toHaveCount(0);

  // Call back puts the caller in the dialer.
  await item.getByRole('button', { name: 'Call back' }).click();
  await expect(dialer(page).getByLabel('Number to call')).toHaveValue('+1 202 555 0172');

  await page.goto(`/contacts/${id}`);
  await expect(timeline(page).getByText('Voicemail · 0:22')).toBeVisible(PIPELINE);
});

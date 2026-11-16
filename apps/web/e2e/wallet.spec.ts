import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import {
  activeCallId,
  callButton,
  callState,
  createContact,
  dialer,
  fakeCallEvent,
  grantManualCall,
  liveCall,
  outcomeDialog,
  PIPELINE,
  wallet,
} from './call-helpers';
import { signUp } from './session';

test.describe.configure({ timeout: 90_000 });

const stat = (page: Page, name: string) => wallet(page).getByRole('group', { name });
const PAUSED = "Calls are paused: the next call would pass this month's STOP cap.";

test('a 61 second call takes exactly $0.02, and a STOP cap pauses calling until raised', async ({
  page,
}) => {
  await signUp(page);
  const id = await createContact(page, 'Ines Duarte', '+1 202 555 0181');
  await grantManualCall(page, id);
  await page.goto(`/calls?contactId=${id}`);
  await expect(stat(page, 'Available')).toContainText('$5.00');
  await expect(stat(page, 'Held')).toContainText('$0.00');
  await expect(wallet(page).getByRole('img', { name: 'Spending normally' })).toBeVisible();

  await callButton(page).click();
  await expect(callState(page)).toHaveText('Connected', PIPELINE);
  await expect(stat(page, 'Held')).toContainText('$0.10', PIPELINE);
  await fakeCallEvent(page, await activeCallId(page), { event: 'completed', billableSeconds: 61 });
  await expect(outcomeDialog(page)).toBeVisible(PIPELINE);
  await outcomeDialog(page).getByRole('button', { name: 'Skip' }).click();
  await expect(stat(page, 'Available')).toContainText('$4.98', PIPELINE);
  await expect(stat(page, 'Held')).toContainText('$0.00');
  await expect(stat(page, 'Spent this month')).toContainText('$0.02');
  await liveCall(page).getByRole('button', { name: 'Done' }).click();

  // Invalid caps are explained inline and nothing is saved.
  await wallet(page).getByRole('button', { name: 'Edit caps' }).click();
  const caps = page.getByRole('dialog', { name: 'Spend caps' });
  await caps.getByLabel('WARN at').fill('abc');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps.getByText('Enter an amount like 5 or 2.50')).toBeVisible();
  await caps.getByLabel('WARN at').fill('1');
  await caps.getByLabel('STOP at').fill('0.05');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps.getByText('WARN must be at or below STOP')).toBeVisible();
  await caps.getByLabel('WARN at').fill('');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps).toHaveCount(0);

  await expect(wallet(page)).toContainText('STOP $0.05');
  await expect(dialer(page).getByText(/^Spend cap reached/)).toBeVisible(PIPELINE);
  await expect(callButton(page)).toBeDisabled();
  // $0.02 spent is under STOP, but the next call's $0.10 hold would pass it: the wallet agrees
  // with the dialer that calls are paused.
  await expect(wallet(page)).toContainText(PAUSED);
  await expect(wallet(page).getByRole('img', { name: 'Calls paused' })).toBeVisible();

  await wallet(page).getByRole('button', { name: 'Edit caps' }).click();
  await expect(caps.getByLabel('STOP at')).toHaveValue('0.05');
  await caps.getByLabel('STOP at').fill('50');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps).toHaveCount(0);
  await expect(callButton(page)).toBeEnabled(PIPELINE);
  await expect(wallet(page).getByRole('img', { name: 'Spending normally' })).toBeVisible();
  await expect(wallet(page)).not.toContainText(PAUSED);

  // Spend already past STOP: the wallet itself says calls are paused.
  await wallet(page).getByRole('button', { name: 'Edit caps' }).click();
  await caps.getByLabel('STOP at').fill('0.01');
  await caps.getByRole('button', { name: 'Save caps' }).click();
  await expect(caps).toHaveCount(0);
  await expect(wallet(page)).toContainText(PAUSED);
  await expect(wallet(page).getByRole('img', { name: 'Calls paused' })).toBeVisible();
  await expect(callButton(page)).toBeDisabled(PIPELINE);
});

test('Add credit raises Available and explains a bad amount', async ({ page }) => {
  await signUp(page);
  await page.goto('/calls');
  await expect(stat(page, 'Available')).toContainText('$5.00');
  await wallet(page).getByRole('button', { name: 'Add credit' }).click();
  const credit = page.getByRole('dialog', { name: 'Add credit' });
  await credit.getByLabel('Amount').fill('two');
  await credit.getByLabel('Note').fill('Owner top-up');
  await credit.getByRole('button', { name: 'Add credit' }).click();
  await expect(credit.getByText('Enter an amount like 5 or 2.50')).toBeVisible();
  await credit.getByLabel('Amount').fill('2.50');
  await credit.getByRole('button', { name: 'Add credit' }).click();
  await expect(credit).toHaveCount(0);
  await expect(stat(page, 'Available')).toContainText('$7.50');
});

test('a failed background refresh keeps the wallet figures on screen', async ({ page }) => {
  // Pass the realtime socket through, so the test can drop it: the reconnect refetches the wallet.
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(/\/api\/v1\/realtime$/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  await signUp(page);
  await page.goto('/calls');
  await expect(stat(page, 'Available')).toContainText('$5.00');
  await expect.poll(() => sockets.length).toBeGreaterThan(0);

  let refused = 0;
  await page.route('**/api/v1/wallet', (route) => {
    refused += 1;
    return route.fulfill({
      status: 500,
      json: { data: null, error: { code: 'internal_error', message: 'Down for a moment.' } },
    });
  });
  await sockets.at(-1)?.close();
  // The refetch and its one retry both fail.
  await expect.poll(() => refused, PIPELINE).toBeGreaterThanOrEqual(2);
  // Give the failed retry a moment to render whatever it would render.
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Edit caps' })).toBeVisible();
  await expect(stat(page, 'Available')).toContainText('$5.00');
  await expect(wallet(page).getByText('We could not load the wallet.')).toHaveCount(0);
});

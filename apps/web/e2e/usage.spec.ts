import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { PIPELINE, placeBilledCall, todayUtc, waitForAvailable } from './usage-helpers';

test.describe.configure({ timeout: 90_000 });

const FORMULA_NOTE = '=HYPERLINK("x")';
const PROVIDER_LOW =
  'Your phone provider balance is low. Top it up with your provider to keep calling.';

async function addCredit(page: Page, amountMicros: number, note: string): Promise<void> {
  const response = await page.request.post('/api/v1/wallet/credits', {
    data: { amountMicros, note, idempotencyKey: crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
}

const walletCard = (page: Page) => page.getByLabel('Wallet', { exact: true });
const ledgerList = (page: Page) => page.getByRole('list', { name: 'Ledger', exact: true });

test('usage shows the wallet, daily spend, a filterable ledger, a CSV export and the provider banner', async ({
  page,
}) => {
  await signUp(page);
  await placeBilledCall(page);
  await waitForAvailable(page, 4_980_000);
  await addCredit(page, 1_000_000, FORMULA_NOTE);

  await page.goto('/usage');
  await expect(walletCard(page)).toContainText('Available');
  await expect(walletCard(page)).toContainText('$5.98', PIPELINE);
  await expect(walletCard(page)).toContainText('Spent this month');

  // The chart is an image with a summary, and its hidden table carries today's number.
  await expect(page.getByRole('img', { name: /Daily spend by channel/ })).toBeVisible();
  const table = page.getByRole('table', { name: 'Daily spend by channel' });
  await expect(table.getByRole('row', { name: new RegExp(todayUtc()) })).toContainText('$0.02');

  // The ledger lists the capture, and Kind narrows it to that one row.
  await expect(ledgerList(page)).toContainText('Call charge');
  await expect(ledgerList(page)).toContainText(FORMULA_NOTE);
  await page.getByLabel('Kind', { exact: true }).selectOption('capture');
  await expect(page).toHaveURL(/kind=capture/);
  await expect(ledgerList(page).getByRole('listitem')).toHaveCount(1);
  await expect(ledgerList(page)).toContainText('Call charge');

  // Another channel has nothing yet.
  await page.getByLabel('Kind', { exact: true }).selectOption('all');
  await page.getByLabel('Channel', { exact: true }).selectOption('sms');
  await expect(page.getByText('No ledger entries match these filters.')).toBeVisible();
  await page.getByLabel('Channel', { exact: true }).selectOption('all');
  await expect(ledgerList(page)).toContainText('Call charge');

  // Export CSV downloads every row, with the formula guard on the note.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^knoqra-ledger-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const path = await file.path();
  const text = await readFile(path, 'utf8');
  expect(text).toContain("'=HYPERLINK");
  expect(text).toContain('Call charge');
  await expect(page.getByText(/Exported \d+ ledger rows\./)).toBeVisible();

  // A low provider balance shows the provider copy once the balance is refreshed.
  const seeded = await page.request.post('/api/v1/dev/fake-provider/balance', {
    data: { balanceMicros: 1_000_000 },
  });
  expect(seeded.status()).toBe(202);
  await page.reload();
  const refreshed = page.waitForResponse('**/usage/balance/refresh');
  await page.getByRole('button', { name: 'Refresh' }).click();
  await refreshed;
  await expect(page.getByText(PROVIDER_LOW)).toBeVisible();
});

import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { PIPELINE, placeBilledCall, todayUtc, waitForAvailable } from './usage-helpers';

test.describe.configure({ timeout: 120_000 });

const DRIFT_MICROS = 30_000;

async function runForToday(page: Page): Promise<void> {
  await page.getByLabel('Day to reconcile').fill(todayUtc());
  await page.getByRole('button', { name: 'Run reconciliation' }).click();
}

const reconciliations = (page: Page) => page.getByRole('list', { name: 'Reconciliations' });

test('reconciliation matches, adjusts for provider drift, then matches again', async ({ page }) => {
  await signUp(page);
  await placeBilledCall(page);
  await waitForAvailable(page, 4_980_000);

  await page.goto('/usage');
  await runForToday(page);
  await expect(reconciliations(page).getByText('Matched')).toHaveCount(1, PIPELINE);

  // The provider reports $0.03 we never booked.
  const seeded = await page.request.post('/api/v1/dev/fake-provider/usage', {
    data: { date: todayUtc(), costMicros: DRIFT_MICROS },
  });
  expect(seeded.status()).toBe(202);

  await runForToday(page);
  const adjusted = reconciliations(page).getByRole('listitem').filter({ hasText: 'Adjusted' });
  await expect(adjusted).toHaveCount(1, PIPELINE);
  await expect(adjusted).toContainText('Drift $0.03');

  // The adjustment is in the ledger as its own row.
  const adjustment = page
    .getByRole('list', { name: 'Ledger', exact: true })
    .getByRole('listitem')
    .filter({ hasText: 'Adjustment' });
  await expect(adjustment).toHaveCount(1, PIPELINE);
  await expect(adjustment).toContainText('-$0.03');

  // With the books corrected, the next run finds nothing to fix.
  await runForToday(page);
  await expect(reconciliations(page).getByText('Matched')).toHaveCount(2, PIPELINE);
});

import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { PIPELINE, placeBilledCall } from './usage-helpers';
import { saveWithFreeCallerId } from './voice-helpers';

// Runs on the fake provider: numbers come from the fake account (0100 to 0102) and calls go through
// the real pipeline, so state changes get the longer PIPELINE timeout.
test.describe.configure({ timeout: 90_000 });

const row = (page: Page, title: string) =>
  page.getByRole('list').getByRole('listitem').filter({ hasText: title });
const tile = (page: Page, label: string) =>
  page
    .getByRole('region', { name: 'Capabilities' })
    .getByRole('listitem')
    .filter({ hasText: label });

test.afterEach(async ({ page }) => {
  // Frees the caller id claim, pass or fail. A test that never signed in gets a 401, which is fine.
  await page.request.delete('/api/v1/voice/connection');
});

async function connectTelnyx(page: Page): Promise<void> {
  await page.getByLabel('API key').fill('KEY0123456789ABCDEFtestonly');
  await page.getByLabel('Credential connection id').fill('conn-test');
  await saveWithFreeCallerId(page, page, page.getByText('••••only'));
}

test('a new workspace sees what to fix, then the checks and tiles follow its setup', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/numbers');
  await expect(page.getByRole('heading', { level: 1, name: 'Numbers' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue setup' })).toBeVisible();

  const credential = row(page, 'Telnyx credential');
  await expect(credential).toContainText('Fail');
  await expect(row(page, 'Number assigned')).toContainText('Fail');
  await expect(row(page, 'Webhook reachable')).toContainText('Pending');
  await expect(row(page, 'Microphone')).toContainText('Pass');
  await expect(page.getByText(/\d of 6 checks pass/)).toBeVisible();
  await expect(
    page.getByText('No numbers yet. Sync them from Telnyx, or connect Telnyx first.'),
  ).toBeVisible();

  // Fix leads to the connect step, where the same form as the wizard saves the connection.
  await credential.getByRole('link', { name: 'Fix' }).click();
  await expect(page).toHaveURL(/\/setup\?step=connect/);
  await connectTelnyx(page);

  await page.goto('/numbers');
  await expect(row(page, 'Telnyx credential')).toContainText('Pass', PIPELINE);

  await page.getByRole('button', { name: 'Sync numbers' }).click();
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(4, PIPELINE); // header + 3 numbers
  const unready = table.getByRole('row').filter({ hasText: '+1 202 555 0102' });
  await expect(unready).toContainText('Pending'); // 10DLC
  await expect(unready.getByText('Pending')).toHaveCount(2); // 10DLC and WhatsApp

  await page
    .getByRole('combobox', { name: 'Assigned use for +1 202 555 0100' })
    .selectOption({ label: 'Calls and messages' });
  await expect(row(page, 'Number assigned')).toContainText('Pass', PIPELINE);
  await expect(row(page, '10DLC registration')).toContainText('Pass', PIPELINE);
  // 0102 has WhatsApp capability with approval pending; it is not ready, with a Meta link.
  const whatsapp = row(page, 'WhatsApp approval');
  await expect(whatsapp).toContainText('Pending', PIPELINE);
  await expect(whatsapp.getByRole('link')).toHaveAttribute('href', /developers\.facebook\.com/);
  await expect(whatsapp.getByRole('link')).toHaveAttribute('target', '_blank');
  await expect(tile(page, 'SMS')).toContainText('Ready');
  await expect(tile(page, 'WhatsApp')).toContainText('Not ready');

  await placeBilledCall(page);
  await page.reload();
  await expect(row(page, 'Webhook reachable')).toContainText('Pass', PIPELINE);
});

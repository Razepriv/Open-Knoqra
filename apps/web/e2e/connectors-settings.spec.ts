import { expect, type Locator, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { CALLER_ID_TAKEN, randomCallerId } from './voice-helpers';

const FAKE_KEY = 'KEY0123456789ABCDEFtestonly';

test.afterEach(async ({ page }) => {
  // Frees the caller id claim if the test died before Disconnect. Without a session it is a 401.
  await page.request.delete('/api/v1/connectors/telnyx');
});

const connectors = (page: Page) => page.getByRole('region', { name: 'Connectors' });
const telnyx = (page: Page) => connectors(page).getByRole('region', { name: 'Telnyx' });

/** Saves the open Telnyx form, trying another caller id while the one picked is claimed. */
async function saveTelnyx(page: Page, card: Locator, saved: Locator): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await card.getByLabel('Caller id').fill(randomCallerId());
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/connectors/telnyx') && r.request().method() === 'PUT',
      { timeout: 15_000 },
    );
    await card.getByRole('button', { name: 'Save connection' }).click();
    if ((await response).status() !== 409) {
      await expect(saved).toBeVisible({ timeout: 15_000 });
      return;
    }
    await expect(card.getByText(CALLER_ID_TAKEN)).toBeVisible();
  }
  throw new Error('Every caller id tried was claimed by another workspace.');
}

test('connect Telnyx, never see the key again, and disconnect it', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings');
  const card = telnyx(page);
  await expect(card.getByText('Not connected')).toBeVisible();
  await expect(connectors(page).getByRole('region', { name: 'Plivo' })).toBeVisible();

  await card.getByRole('button', { name: 'Connect Telnyx' }).click();
  const key = card.getByLabel('API key');
  await expect(key).toHaveAttribute('type', 'password');
  await expect(key).toHaveAttribute('autocomplete', 'off');
  await key.fill(FAKE_KEY);
  await card.getByLabel('Credential connection id').fill('1234567890');
  await saveTelnyx(page, card, card.getByText('Key ending ••••only'));
  expect(await page.content()).not.toContain(FAKE_KEY);
  await expect(card.getByText('Connection webhook URL')).toBeVisible();

  await page.reload();
  await expect(telnyx(page).getByText('Key ending ••••only')).toBeVisible();
  expect(await page.content()).not.toContain(FAKE_KEY);

  await telnyx(page).getByRole('button', { name: 'Disconnect Telnyx' }).click();
  const confirm = page.getByRole('dialog', { name: 'Disconnect Telnyx?' });
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByText('Telnyx disconnected')).toBeVisible();
  await expect(telnyx(page).getByText('Not connected')).toBeVisible();
  await expect(telnyx(page).getByText(/^Key ending/)).toHaveCount(0);
});

test('the connectors anchor opens on the Connectors card', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings#connectors');
  const section = page.locator('#connectors');
  await expect(section).toHaveCount(1);
  await expect(section.getByRole('heading', { name: 'Connectors' })).toBeInViewport();
});

test('required fields and a bad caller id are explained', async ({ page }) => {
  await signUp(page);
  await page.goto('/settings');
  const card = telnyx(page);
  await card.getByRole('button', { name: 'Connect Telnyx' }).click();
  await card.getByRole('button', { name: 'Save connection' }).click();
  await expect(card.getByText('Enter the API key.')).toBeVisible();
  await card.getByLabel('API key').fill(FAKE_KEY);
  await card.getByLabel('Credential connection id').fill('1234567890');
  await card.getByLabel('Caller id').fill('12');
  await card.getByRole('button', { name: 'Save connection' }).click();
  await expect(
    card.getByText('Enter a full number with country code, like +1 202 555 0123.'),
  ).toBeVisible();
  await expect(card.getByText('Not connected')).toBeVisible();
});

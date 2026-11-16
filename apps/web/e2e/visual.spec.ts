import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { seedWorkspace } from './completeness/seed';
import { enableTwoFactor, newAccount, signInToChallenge } from './helpers';
import { signUp } from './session';
import { freezeTime, HEIGHT, shootAll } from './visual/frames';

/**
 * Visual baselines for the M1 screens at five widths in both themes. Runs only in the `visual`
 * project (see playwright.config.ts); baselines live in e2e/visual/__baselines__/<platform>/.
 */

const CSV = fileURLToPath(new URL('./fixtures/contacts.csv', import.meta.url));

test.describe.configure({ timeout: 240_000 });
test.use({ viewport: { width: 1440, height: HEIGHT }, timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await freezeTime(page);
});

async function signedUp(page: Page, name = 'Ana Silva'): Promise<string> {
  const { email } = await signUp(page, { name });
  return email;
}

test.describe('signed out', () => {
  for (const screen of ['sign-in', 'sign-up', 'forgot-password'] as const) {
    test(screen, async ({ page }) => {
      await page.goto(`/${screen}`);
      await expect(page.getByRole('main')).toBeVisible();
      await shootAll(page, screen);
    });
  }

  test('reset-password, invalid link', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByRole('main')).toBeVisible();
    await shootAll(page, 'reset-password-invalid');
  });

  test('reset-password, form', async ({ page }) => {
    await page.goto('/reset-password?token=x');
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await shootAll(page, 'reset-password-form');
  });

  test('two-factor challenge', async ({ page, context }) => {
    const account = newAccount();
    await signUp(page, { email: account.email });
    await enableTwoFactor(page);
    await signInToChallenge(page, context, account);
    await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible();
    await shootAll(page, 'two-factor');
  });
});

test.describe('contacts', () => {
  test('contacts-empty', async ({ page }) => {
    const email = await signedUp(page);
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shootAll(page, 'contacts-empty', { email });
  });

  test('contacts-full and contact-360', async ({ page }) => {
    const email = await signedUp(page);
    const seed = await seedWorkspace(page.request);
    await page.goto('/contacts');
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    await shootAll(page, 'contacts-full', { email });

    await page.goto(`/contacts/${seed.full}`);
    await expect(page.getByRole('heading', { name: 'Marisol Quintero', level: 1 })).toBeVisible();
    await expect(page.getByText('Wants a quote for 40 m2 of tile.')).toBeVisible();
    await shootAll(page, 'contact-360', { email });
  });
});

test('import steps', async ({ page }) => {
  const email = await signedUp(page);
  await page.goto('/contacts/import');
  await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
  await shootAll(page, 'import-upload', { email });

  await page.getByLabel('Choose a CSV file').setInputFiles(CSV);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await shootAll(page, 'import-map', { email });

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Review before importing' })).toBeVisible();
  await shootAll(page, 'import-review', { email });

  await page.getByRole('button', { name: 'Import 6 contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await shootAll(page, 'import-results', { email });
});

test('settings sections', async ({ page }) => {
  const email = await signedUp(page);
  await page.goto('/settings');
  await expect(page.getByRole('list', { name: 'Signed-in devices' })).toBeVisible();
  for (const section of ['Profile', 'Preferences', 'Security', 'Sessions'] as const) {
    await shootAll(page, `settings-${section.toLowerCase()}`, {
      email,
      target: (p) => p.getByRole('region', { name: section }),
    });
  }
});

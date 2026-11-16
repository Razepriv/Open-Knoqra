import { expect, type Page, test } from '@playwright/test';
import { addContact } from './contact-helpers';
import { signUp } from './session';

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const input = (page: Page) => page.getByPlaceholder('Search, jump or create…');

test('ctrl+k opens the palette; it jumps, opens contacts, creates a task and closes', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ines Duarte', phone: '+1 202 555 0151' });

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await input(page).fill('tasks');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(palette(page)).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await input(page).fill('Ines');
  const option = palette(page).getByRole('option', { name: /Ines Duarte/ });
  await expect(option).toBeVisible();
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/contacts\/ct_/);

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await input(page).fill('Call the dentist');
  await palette(page).getByRole('option', { name: 'Create task: Call the dentist' }).click();
  await expect(page.getByText('Task added.')).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
  await expect(page.getByText('Call the dentist')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('escape returns focus to where it was, and old contact results never linger', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ines Duarte', phone: '+1 202 555 0151' });
  await addContact(page, { name: 'Maya Pires', phone: '+1 202 555 0152' });

  await page.goto('/tasks');
  const title = page.getByLabel('Title');
  await title.focus();
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await input(page).fill('Ines');
  await expect(palette(page).getByRole('option', { name: /Ines Duarte/ })).toBeVisible();

  // Hold the next search back: while it is in flight Ines must not stay listed or selectable.
  await page.route('**/api/v1/contacts?*q=Maya*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await input(page).fill('Maya');
  await page.waitForTimeout(400);
  await expect(palette(page).getByRole('option', { name: /Ines Duarte/ })).toHaveCount(0);
  await expect(palette(page).getByRole('option', { name: /Maya Pires/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(title).toBeFocused();
});

import { expect, test } from '@playwright/test';
import { signUp } from './session';

test('a past reminder shows in the bell, opens tasks and clears', async ({ page }) => {
  await signUp(page);
  const remindAt = new Date(Date.now() - 60_000).toISOString();
  for (const title of ['Send the quote', 'Book the venue']) {
    const res = await page.request.post('/api/v1/tasks', { data: { title, remindAt } });
    expect(res.ok()).toBe(true);
  }
  await page.goto('/');

  const bell = page.getByRole('button', { name: 'Notifications, 2 unread' });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel.getByText('Reminder: Send the quote')).toBeVisible();

  await panel.getByRole('link', { name: /Reminder: Send the quote/ }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('button', { name: 'Notifications, 1 unread' })).toBeVisible();

  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
});

test('a failed mark-read still tells the user after the panel closes', async ({ page }) => {
  await signUp(page);
  const remindAt = new Date(Date.now() - 60_000).toISOString();
  const res = await page.request.post('/api/v1/tasks', {
    data: { title: 'Pay the invoice', remindAt },
  });
  expect(res.ok()).toBe(true);
  await page.goto('/');
  await page.route('**/api/v1/notifications/*/read', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'x' } }),
    }),
  );

  await page.getByRole('button', { name: 'Notifications, 1 unread' }).click();
  await page.getByRole('link', { name: /Reminder: Pay the invoice/ }).click();
  await expect(page.getByText("Couldn't update notifications. Try again.")).toBeVisible();
});

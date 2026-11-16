import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';

/**
 * The System status section in Settings, for workspace owners and admins. Against the real local
 * API the queue (and so the overall status) may read degraded because the shared test database
 * keeps unprocessed provider events, so these tests never assert an overall `ok`.
 */

function section(page: Page) {
  return page.getByRole('region', { name: 'System status' });
}

function checkRow(page: Page, list: 'Server checks' | 'This browser', label: string) {
  return section(page)
    .getByRole('list', { name: list })
    .getByRole('listitem')
    .filter({ has: page.getByText(label, { exact: true }) });
}

async function expectCheck(
  page: Page,
  list: 'Server checks' | 'This browser',
  label: string,
  status: 'ok' | 'off',
) {
  const state = checkRow(page, list, label).locator('[data-status]');
  await expect(state).toHaveAttribute('data-status', status);
  await expect(state).toHaveText(status === 'ok' ? 'OK' : 'Off');
}

for (const viewport of [null, { width: 390, height: 844 }] as const) {
  test.describe(`at ${viewport ? `${viewport.width}x${viewport.height}` : 'the default viewport'}`, () => {
    if (viewport) test.use({ viewport });

    test('an owner sees the server and browser checks and can refresh them', async ({ page }) => {
      await signUp(page);
      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

      const region = section(page);
      await expect(region.getByRole('heading', { name: 'System status', level: 2 })).toBeVisible();
      await expect(
        region.getByText(
          /^(All systems normal|Some systems need attention|A critical system is down)$/,
        ),
      ).toBeVisible();

      await expectCheck(page, 'Server checks', 'Database', 'ok');
      await expect(checkRow(page, 'Server checks', 'Provider')).toContainText('Not connected');
      await expectCheck(page, 'Server checks', 'Sentry', 'off');
      await expectCheck(page, 'Server checks', 'PostHog', 'off');
      await expect(
        region.getByRole('list', { name: 'Server checks' }).getByRole('listitem'),
      ).toHaveCount(9);
      await expectCheck(page, 'This browser', 'Sentry (Desk)', 'off');
      await expectCheck(page, 'This browser', 'PostHog (Desk)', 'off');

      const time = region.locator('time');
      await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
      const before = await time.getAttribute('datetime');
      if (!before) throw new Error('the checked time has no datetime');

      // checkedAt has millisecond precision; wait past a second so the new report differs visibly.
      await page.waitForTimeout(1100);
      const refresh = region.getByRole('button', { name: 'Refresh' });
      await refresh.click();
      await expect(time).not.toHaveAttribute('datetime', before);
      await expect(
        region.getByRole('status').filter({ hasText: 'System status updated' }),
      ).toHaveCount(1);
      await expect(refresh).toBeFocused();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}

test('a failed check shows the error state, and Try again asks again', async ({ page }) => {
  let fail = true;
  let requests = 0;
  await page.route('**/api/health/deep', async (route) => {
    requests += 1;
    if (!fail) return route.fallback();
    return route.fulfill({
      status: 500,
      json: { data: null, error: { code: 'internal_error', message: 'Something went wrong.' } },
    });
  });

  await signUp(page);
  await page.goto('/settings');
  const region = section(page);
  // The Desk retries a failed query once, after a back-off, before showing the error.
  await expect(
    region.getByText('We could not check system status. The API or database may be down.'),
  ).toBeVisible({ timeout: 15_000 });
  const before = requests;
  expect(before).toBeGreaterThan(0);

  fail = false;
  await region.getByRole('button', { name: 'Try again' }).click();
  await expect(checkRow(page, 'Server checks', 'Database')).toBeVisible();
  expect(requests).toBeGreaterThan(before);
  await expect(region.getByRole('status').filter({ hasText: 'System status updated' })).toHaveCount(
    1,
  );
  // Focus was on Try again, which the swap removed: it moves to the newly shown Refresh.
  await expect(region.getByRole('button', { name: 'Refresh' })).toBeFocused();
});

test('a refresh that fails moves focus to Try again', async ({ page }) => {
  let fail = false;
  await page.route('**/api/health/deep', async (route) => {
    if (!fail) return route.fallback();
    return route.fulfill({
      status: 500,
      json: { data: null, error: { code: 'internal_error', message: 'Something went wrong.' } },
    });
  });

  await signUp(page);
  await page.goto('/settings');
  const region = section(page);
  await expect(checkRow(page, 'Server checks', 'Database')).toBeVisible();
  fail = true;
  await region.getByRole('button', { name: 'Refresh' }).click();
  // A manual refetch is not retried, so the error shows straight away.
  await expect(region.getByRole('button', { name: 'Try again' })).toBeFocused({ timeout: 15_000 });
});

test('a forbidden response says only owners and admins can see the status', async ({ page }) => {
  await page.route('**/api/health/deep', (route) =>
    route.fulfill({
      status: 403,
      json: {
        data: null,
        error: { code: 'forbidden', message: 'Only owners and admins can see system status.' },
      },
    }),
  );

  await signUp(page);
  await page.goto('/settings');
  const region = section(page);
  await expect(
    region.getByText('Only workspace owners and admins can see system status.'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(region.getByText(/The API or database may be down/)).toHaveCount(0);
  // Nothing in the section had focus, so the error view does not take it.
  await expect(region.getByRole('button', { name: 'Try again' })).not.toBeFocused();
});

test('a degraded report says so and shows the server detail', async ({ page }) => {
  const now = new Date().toISOString();
  const check = (id: string, label: string, status: string, detail: string) => ({
    id,
    label,
    status,
    detail,
    data: null,
    durationMs: 3,
  });
  await page.route('**/api/health/deep', (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          status: 'degraded',
          checkedAt: now,
          release: null,
          environment: 'development',
          checks: [
            check('database', 'Database', 'ok', 'Reachable'),
            check('queue', 'Webhook queue', 'degraded', 'Processing is behind by 12 min'),
          ],
        },
        error: null,
      },
    }),
  );

  await signUp(page);
  await page.goto('/settings');
  const region = section(page);
  await expect(region.getByText('Some systems need attention', { exact: true })).toBeVisible();
  const queue = checkRow(page, 'Server checks', 'Webhook queue');
  await expect(queue).toContainText('Processing is behind by 12 min');
  await expect(queue.locator('[data-status]')).toHaveAttribute('data-status', 'degraded');
  await expect(queue.locator('[data-status]')).toHaveText('Degraded');
});

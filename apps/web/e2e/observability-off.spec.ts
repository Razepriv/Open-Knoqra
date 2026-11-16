import { expect, test } from '@playwright/test';
import { WEB_ORIGIN } from './ports';
import { signUp } from './session';

/**
 * A request for Sentry or PostHog code or endpoints. Vite dev serves the Desk's own modules by
 * source path, and the always-loaded wrapper (`/src/lib/observability/sentry.ts`) is named after
 * the integration, so own source is allowed, except the lazy `*-sdk.ts` entry points that pull in
 * the SDK packages: those must never load while the integration is off.
 */
function isSdkRequest(url: string): boolean {
  if (!/sentry|posthog/i.test(url)) return false;
  const { pathname } = new URL(url);
  return !pathname.startsWith('/src/') || /-sdk\.ts$/.test(pathname);
}

function expectOnlyOwnOrigin(urls: readonly string[]): void {
  // Inline data: and blob: URLs never leave the browser, so they carry no origin to check.
  const network = urls.filter((url) => !/^(data|blob):/.test(url));
  const offOrigin = network.filter((url) => new URL(url).origin !== WEB_ORIGIN);
  expect(offOrigin).toEqual([]);
  expect(network.filter(isSdkRequest)).toEqual([]);
}

/**
 * With no Sentry or PostHog keys (the local and E2E default), the Desk talks to nobody but its
 * own origin: no SDK download, no event, no third-party request of any kind.
 */
test('with observability off, every request stays on the Desk origin', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (request) => {
    urls.push(request.url());
  });

  await signUp(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.goto('/contacts');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/contacts/);
  await page.goBack();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  expect(urls.length).toBeGreaterThan(0);
  expectOnlyOwnOrigin(urls);

  const before = urls.length;
  await page.goto('/settings');
  await expect(page.getByLabel('Share anonymous usage data')).toHaveAccessibleDescription(
    /switched off on this server/,
  );
  // The final visit is checked too, so no recorded request goes unchecked.
  expect(urls.length).toBeGreaterThan(before);
  expectOnlyOwnOrigin(urls);
});

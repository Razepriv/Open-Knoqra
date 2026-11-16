import { expect, test } from '@playwright/test';
import { signIn, signUp } from './session';

const primary = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Primary' });

test('every rail link is present, navigates and marks the current page', async ({ page }) => {
  await signUp(page);
  const rail = primary(page);
  await expect(rail.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');

  const pages = [
    { name: 'Inbox', path: '/inbox' },
    { name: 'Calls', path: '/calls' },
    { name: 'Contacts', path: '/contacts' },
    { name: 'Usage', path: '/usage' },
    { name: 'Numbers', path: '/numbers' },
  ];
  for (const { name, path } of pages) {
    await rail.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(rail.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await expect(rail.getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
  }
  // Settings is built on another branch, but it has its place in the rail.
  await expect(rail.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
});

test('every page in the shell names itself in the tab title', async ({ page }) => {
  await signUp(page);
  await expect(page).toHaveTitle('Today · KNOQRA');
  const pages = [
    { name: 'Inbox', title: 'Inbox · KNOQRA' },
    { name: 'Calls', title: 'Calls · KNOQRA' },
    { name: 'Contacts', title: 'Contacts · KNOQRA' },
    { name: 'Usage', title: 'Usage · KNOQRA' },
    { name: 'Numbers', title: 'Numbers · KNOQRA' },
  ];
  for (const { name, title } of pages) {
    await primary(page).getByRole('link', { name }).click();
    await expect(page).toHaveTitle(title);
  }
  await primary(page).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveTitle('Settings · KNOQRA');
  await page.goto('/contacts/import');
  await expect(page).toHaveTitle('Import contacts · KNOQRA');
  // Leaving the shell must not leave the last page's name on the sign-in tab.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
  await expect(page).toHaveTitle('KNOQRA');
});

test('the pages that were stubs now open their feature', async ({ page }) => {
  await signUp(page);
  await primary(page).getByRole('link', { name: 'Calls' }).click();
  await expect(page.getByRole('region', { name: 'Dialer' })).toBeVisible();
  await primary(page).getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeAttached();
  await expect(page.getByRole('heading', { level: 2, name: 'Ledger' })).toBeVisible();
  await primary(page).getByRole('link', { name: 'Numbers' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Numbers' })).toBeVisible();
  await expect(page.getByText(/opens in M\d/)).toHaveCount(0);
});

test('the rail is reachable by keyboard and a skip link jumps to the content', async ({ page }) => {
  await signUp(page);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('the user menu shows the account and signs out', async ({ page }) => {
  const { email } = await signUp(page, { name: 'Ana Silva' });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menu')).toContainText('Ana Silva');
  await expect(page.getByRole('menu')).toContainText(email);
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute(
    'href',
    '/settings',
  );
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
});

test('the theme comes from the server: it survives a reload and a fresh sign-in', async ({
  page,
  browser,
}) => {
  const { email } = await signUp(page);
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  await expect(toggle).toHaveAccessibleName('Theme: system. Switch to light');
  const isSave = (r: import('@playwright/test').Response) =>
    r.url().endsWith('/api/v1/me/prefs') && r.request().method() === 'PATCH';
  const first = page.waitForResponse(isSave);
  await toggle.click(); // system → light
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await first; // one save at a time: the next press is taken once this one has finished
  await expect(toggle).toHaveAttribute('aria-busy', 'false');
  const saved = page.waitForResponse(isSave);
  await toggle.click(); // light → dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await saved).status()).toBe(200);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // A fresh browser context has no localStorage, so only the server can say "dark".
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await signIn(other, email);
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally {
    await fresh.close();
  }
});

test('at full width the context ribbon sits beside the page', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open context' })).toHaveCount(0);
});

test('at 1100px the ribbon moves into a drawer opened from the top bar', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await signUp(page);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open context' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open context' })).toBeFocused();
});

test('at 800px the rail becomes a bottom bar', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await signUp(page);
  // Today is taller than the window and the bar sticks to its bottom edge while scrolling, so
  // compare where it rests at the end of the page, below the content.
  await expect(page.getByRole('img', { name: /outcomes today/ })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const rail = await primary(page).boundingBox();
  const main = await page.locator('main#main').boundingBox();
  if (!rail || !main) throw new Error('rail or main is not laid out');
  expect(rail.width).toBeGreaterThan(rail.height * 4);
  expect(rail.y).toBeGreaterThanOrEqual(main.y + main.height - 1);
});

test('signing out clears the cached theme so the next visitor starts from the system', async ({
  page,
}) => {
  await signUp(page);
  await page.getByRole('button', { name: /^Theme:/ }).click(); // system → light
  expect(await page.evaluate(() => localStorage.getItem('knoqra.theme'))).toBe('light');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
  expect(await page.evaluate(() => localStorage.getItem('knoqra.theme'))).toBeNull();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});

test('two quick presses of the theme toggle end on the theme the server saved', async ({
  page,
}) => {
  await signUp(page);
  // A slow save makes the second press land while the first is still in flight.
  let saves = 0;
  await page.route('**/api/v1/me/prefs', async (route) => {
    if (route.request().method() === 'PATCH') {
      saves += 1;
      await new Promise((r) => setTimeout(r, 700));
    }
    await route.continue();
  });
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/prefs') && r.request().method() === 'PATCH',
  );
  await toggle.click();
  await toggle.click();
  await saved;
  await page.waitForTimeout(1500); // let any second save finish too
  // One save at a time: the second press waits for the first instead of racing it.
  expect(saves).toBe(1);
  const applied = await page.locator('html').getAttribute('data-theme');
  await page.unroute('**/api/v1/me/prefs');
  await page.reload();
  // Whatever is on screen is what the server holds.
  if (applied) await expect(page.locator('html')).toHaveAttribute('data-theme', applied);
  else await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  await expect(toggle).toHaveAccessibleName(new RegExp(`^Theme: ${applied ?? 'system'}.`));
});

test('the context drawer closes when the window grows wide and stays closed after', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await signUp(page);
  await page.getByRole('button', { name: 'Open context' }).click();
  await expect(page.getByRole('dialog', { name: 'Workspace' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Workspace' })).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.getByRole('button', { name: 'Open context' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

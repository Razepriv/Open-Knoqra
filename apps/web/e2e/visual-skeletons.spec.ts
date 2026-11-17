import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { seedWorkspace } from './completeness/seed';
import { TEST_PASSWORD, uniqueEmail } from './session';
import { type Frame, HEIGHT, selectedFrames } from './visual/frames';

/**
 * Held-back loading outlines, one baseline per route, width and theme:
 * `<route>-skeleton-<width>-<theme>.png`. The page script and the data are held, the static
 * outline from index.html is replaced by React's own, and reduced motion keeps the glyphs still.
 */

test.describe.configure({ timeout: 240_000 });

/** Holds matching requests until the page is closed. */
async function hold(page: Page, matches: (url: URL) => boolean): Promise<Route[]> {
  const held: Route[] = [];
  await page.route(
    (url) => matches(url),
    (route) => {
      held.push(route);
    },
  );
  return held;
}

const isSession = (url: URL) => url.pathname === '/api/auth/get-session';
const isAppData = (url: URL) => url.pathname.startsWith('/api/v1/');
const isEntry = (url: URL) => url.pathname === '/src/main.tsx';

/**
 * React's own outline is on the page: the static one from index.html (`#kq-outline`) is gone.
 * `__reactContainer` is no use here, React sets it at createRoot, before the first commit.
 */
async function reactMounted(page: Page): Promise<void> {
  await expect(page.locator('#kq-outline')).toHaveCount(0);
}

/** Fonts loaded and one frame painted. Not the full settle: the data is held on purpose. */
async function readyToShoot(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(done))),
  );
}

const frames = selectedFrames();

const APP_IDS = [
  { id: 'today', path: () => '/' },
  { id: 'tasks', path: () => '/tasks' },
  { id: 'contacts', path: () => '/contacts' },
  { id: 'contact-360', path: (full: string) => `/contacts/${full}` },
  { id: 'contacts-import', path: () => '/contacts/import' },
  { id: 'settings', path: () => '/settings' },
] as const;

let storageState: BrowserContextOptions['storageState'];
let fullId: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(uniqueEmail('visual-skeleton'));
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('checkbox', { name: /I agree to the Terms/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 60_000 });
  fullId = (await seedWorkspace(page.request)).full;
  storageState = await context.storageState();
  await context.close();
});

async function newFramePage(browser: Browser, frame: Frame, signedIn: boolean) {
  const context = await browser.newContext({
    ...(signedIn ? { storageState } : {}),
    viewport: { width: frame.width, height: HEIGHT },
    colorScheme: frame.theme,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    locale: 'en-US',
  });
  const page = await context.newPage();
  // No frozen clock here: the router's pending delay reads Date, and an outline has no dates.
  return { context, page };
}

for (const app of APP_IDS) {
  test(`${app.id} skeleton`, async ({ browser }) => {
    for (const frame of frames) {
      const { context, page } = await newFramePage(browser, frame, true);
      const entry = await hold(page, isEntry);
      await hold(page, isSession);
      await hold(page, isAppData);
      await page.goto(app.path(fullId), { waitUntil: 'commit' });
      await expect(page.locator('#root [data-skeleton="shell"]')).toBeVisible();
      for (const route of entry.splice(0)) await route.fallback();
      await reactMounted(page);
      await expect(
        page.locator(`[data-skeleton="shell"] [data-skeleton="${app.id}"]`),
      ).toBeVisible();
      await readyToShoot(page);
      const name = `${app.id}-skeleton-${frame.width}-${frame.theme}.png`;
      await expect(page, name).toHaveScreenshot(name, { fullPage: true });
      await context.close();
    }
  });
}

const AUTH = [
  { id: 'sign-in', path: '/sign-in', checksSession: true },
  { id: 'sign-up', path: '/sign-up', checksSession: true },
  { id: 'two-factor', path: '/two-factor', checksSession: true },
  // These two render their form without asking for a session, so the only outline they ever
  // show is the static one from index.html.
  { id: 'forgot-password', path: '/forgot-password', checksSession: false },
  { id: 'reset-password', path: '/reset-password?token=x', checksSession: false },
] as const;

for (const auth of AUTH) {
  test(`${auth.id} skeleton`, async ({ browser }) => {
    for (const frame of frames) {
      const { context, page } = await newFramePage(browser, frame, false);
      const entry = await hold(page, isEntry);
      await hold(page, isSession);
      await page.goto(auth.path, { waitUntil: 'commit' });
      await expect(page.locator(`#root [data-skeleton="${auth.id}"]`)).toBeVisible();
      if (auth.checksSession) {
        for (const route of entry.splice(0)) await route.fallback();
        await reactMounted(page);
        await expect(page.locator(`main[data-skeleton="${auth.id}"]`)).toBeVisible();
      }
      await readyToShoot(page);
      const name = `${auth.id}-skeleton-${frame.width}-${frame.theme}.png`;
      await expect(page, name).toHaveScreenshot(name, { fullPage: true });
      await context.close();
    }
  });
}

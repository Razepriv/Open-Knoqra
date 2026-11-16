import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { accessibilityProblems } from './completeness/a11y';
import { isPending, readPendingRoutes } from './completeness/allowlist';
import { expandRoutes, type RouteTarget, readRoutePatterns } from './completeness/routes';
import { createThrowaway, seedWorkspace } from './completeness/seed';
import { createContactApi, openInbox } from './inbox-helpers';
import { TEST_PASSWORD, uniqueEmail } from './session';
import { saveWithFreeCallerId } from './voice-helpers';

/**
 * The axe scan of every route in both themes, the open states of the M1 screens, and keyboard and
 * focus checks. Every test collects all its problems and fails once with the full list.
 */

const CSV = fileURLToPath(new URL('./fixtures/contacts.csv', import.meta.url));
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

test.describe.configure({ timeout: 300_000 });

let storageState: BrowserContextOptions['storageState'];
let targets: RouteTarget[];
let twinId: string;
let seededId: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page.getByLabel('Email').fill(uniqueEmail('a11y'));
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 60_000 });
  const seed = await seedWorkspace(page.request);
  const throwaway = await createThrowaway(page.request, 'a11y');
  // Two people with the same name, so the second one shows a suggested match to review.
  await createContactApi(page, 'Maya Okafor', '+1 202 555 0191');
  twinId = (await createContactApi(page, 'Maya Okafor', '+1 202 555 0192')).id;
  seededId = seed.full;
  const pending = readPendingRoutes();
  targets = expandRoutes(readRoutePatterns(), seed, throwaway).filter(
    (target) => !isPending(target.pattern, pending),
  );
  storageState = await context.storageState();
  await context.close();
});

async function frame(
  browser: Browser,
  options: { theme: Theme; width: number; height?: number; signedIn: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    ...(options.signedIn ? { storageState } : {}),
    viewport: { width: options.width, height: options.height ?? 900 },
    colorScheme: options.theme,
  });
  return { context, page: await context.newPage() };
}

// ---------------------------------------------------------------------------------------------
// Every route

const MATRIX = [
  { theme: 'light', width: 1440 },
  { theme: 'dark', width: 1440 },
  { theme: 'light', width: 390 },
] as const;

for (const { theme, width } of MATRIX) {
  for (const auth of ['public', 'app'] as const) {
    test(`${auth} routes at ${width} in ${theme}`, async ({ browser }) => {
      const { context, page } = await frame(browser, { theme, width, signedIn: auth === 'app' });
      const problems: string[] = [];
      const pages = targets.filter((target) => target.auth === auth);
      // Pages that also have a state worth scanning without a session or token.
      const extra = auth === 'public' ? ['/reset-password?token=x'] : [];
      const urls = [
        ...pages.map((t) => ({ url: t.url, label: t.label })),
        ...extra.map((url) => ({ url, label: url })),
      ];
      expect(urls.length).toBeGreaterThan(0);
      for (const { url, label } of urls) {
        await page.goto(url);
        problems.push(
          ...(await accessibilityProblems(page, `${label} @${width} ${theme}`, {
            // The showcase draws every skeleton state on purpose, so it never finishes loading.
            allowLoading: url === '/showcase',
          })),
        );
      }
      await context.close();
      expect(problems).toEqual([]);
    });
  }
}

test('the layout outage keeps one main with a heading', async ({ browser }) => {
  const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
  await page.route('**/api/v1/me', (route) => route.abort());
  await page.goto('/settings');
  await expect(page.getByText(/We can't reach KNOQRA/).first()).toBeVisible();
  const problems = await accessibilityProblems(page, 'layout outage');
  // The outage is the page's own main: not inside another main or any other landmark.
  const mainInfo = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      id: main?.id,
      enclosing: main?.parentElement?.closest(
        'main, section, aside, nav, header, footer, form, [role="main"], [role="region"]',
      )
        ? 'landmark'
        : null,
      hasOutage: main?.querySelector('section h1') !== null,
    };
  });
  await context.close();
  expect(problems).toEqual([]);
  expect(mainInfo).toEqual({ id: 'main', enclosing: null, hasOutage: true });
});

// A page-level outage renders inside the shell's own main, so it must not add a second one.
test('the setup outage does not nest a second main', async ({ browser }) => {
  const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
  await page.route('**/api/v1/setup', (route) => route.abort());
  await page.goto('/setup');
  await expect(page.getByText(/We can't reach KNOQRA/).first()).toBeVisible();
  const problems = await accessibilityProblems(page, 'setup outage');
  await context.close();
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// Open states, in both themes

for (const theme of THEMES) {
  test(`open states in ${theme}`, async ({ browser }) => {
    const { context, page } = await frame(browser, { theme, width: 1440, signedIn: true });
    const problems: string[] = [];
    const scan = async (label: string) =>
      problems.push(...(await accessibilityProblems(page, `${label} ${theme}`)));

    // Add contact dialog and the account menu, from the list.
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'Add contact' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Add contact' })).toBeVisible();
    await scan('add contact dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await scan('account menu');
    await page.keyboard.press('Escape');

    // Edit contact on Contact 360.
    await page.goto(`/contacts/${seededId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit contact' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
    await scan('edit contact dialog');
    await page.keyboard.press('Escape');

    // The duplicate review: the card, then its merge dialog.
    await page.goto(`/contacts/${twinId}`);
    const card = page.getByRole('group', { name: 'Suggested match' });
    await expect(card).toBeVisible();
    await scan('duplicate review');
    await card.getByRole('button', { name: /^Merge/ }).click();
    await expect(page.getByRole('dialog', { name: 'Merge contacts' })).toBeVisible();
    await scan('merge dialog');
    await page.keyboard.press('Escape');

    // The context drawer, below the width where the ribbon is a third pane.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`/contacts/${seededId}`);
    await page.getByRole('button', { name: 'Open context' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await scan('context drawer at 1100');
    await page.setViewportSize({ width: 1440, height: 900 });

    // Two-factor setup in Settings.
    await page.goto('/settings');
    const security = page.getByRole('region', { name: 'Security' });
    await security.getByLabel('Confirm your password').fill(TEST_PASSWORD);
    await security.getByRole('button', { name: 'Set up two-factor' }).click();
    await expect(security.getByTestId('totp-secret')).toBeVisible();
    await scan('two-factor setup');
    await context.close();
    expect(problems).toEqual([]);
  });

  test(`import steps in ${theme}`, async ({ browser }) => {
    const { context, page } = await frame(browser, { theme, width: 1440, signedIn: false });
    const problems: string[] = [];
    const scan = async (label: string) =>
      problems.push(...(await accessibilityProblems(page, `${label} ${theme}`)));
    // Its own account: the results step creates contacts.
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Ana Silva');
    await page.getByLabel('Email').fill(uniqueEmail('a11y-import'));
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({
      timeout: 60_000,
    });
    await page.goto('/contacts/import');
    await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
    await scan('import upload');
    await page.getByLabel('Choose a CSV file').setInputFiles(CSV);
    await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
    await scan('import map');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Review before importing' })).toBeVisible();
    await scan('import review');
    await page.getByRole('button', { name: 'Import 6 contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
    await scan('import results');
    await context.close();
    expect(problems).toEqual([]);
  });
}

test('an inbox conversation and its composer', async ({ browser }) => {
  const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
  const contact = await createContactApi(page, 'Inbox Iris', '+1 202 555 0193');
  await openInbox(page, contact.id, 'sms');
  const problems = await accessibilityProblems(page, 'inbox conversation');
  await context.close();
  expect(problems).toEqual([]);
});

// The calling, numbers and setup screens in the states a person reaches without live keys: the
// fake Telnyx provider supplies the numbers and the purchase.
for (const theme of THEMES) {
  test(`setup, calls and numbers states in ${theme}`, async ({ browser }) => {
    const { context, page } = await frame(browser, { theme, width: 1440, signedIn: false });
    const problems: string[] = [];
    const scan = async (label: string) =>
      problems.push(...(await accessibilityProblems(page, `${label} ${theme}`)));
    try {
      await page.goto('/sign-up');
      await page.getByLabel('Name').fill('Ana Silva');
      await page.getByLabel('Email').fill(uniqueEmail('a11y-setup'));
      await page.getByLabel('Password').fill(TEST_PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({
        timeout: 60_000,
      });

      await page.goto('/setup');
      await expect(page.getByRole('heading', { level: 2, name: 'Connect Telnyx' })).toBeVisible();
      await scan('setup connect step');
      await page.getByLabel('API key').fill('KEY0123456789ABCDEFtestonly');
      await page.getByLabel('Credential connection id').fill('conn-test');
      await saveWithFreeCallerId(page, page, page.getByText('••••only'));
      await scan('setup connect step, saved');
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Choose a number' })).toBeVisible();
      await scan('setup number step');
      await page.getByRole('button', { name: 'Sync from Telnyx' }).click();
      await expect(page.getByRole('radio')).toHaveCount(3, { timeout: 20_000 });
      await scan('setup number step, synced');
      await page.getByRole('radio', { name: /\+1 202 555 0100/ }).check();
      await page.getByRole('button', { name: 'Use for calls and messages' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Test audio' })).toBeVisible({
        timeout: 20_000,
      });
      await scan('setup audio step');

      await page.goto('/calls');
      await page
        .getByRole('region', { name: 'Dialer' })
        .getByLabel('Number to call')
        .fill('+1 202 555 0177');
      await scan('calls dialer with a number');

      await page.goto('/numbers');
      await page.getByRole('button', { name: 'Buy a number' }).click();
      await page.getByLabel('Area code').fill('202');
      await expect(page.getByRole('list', { name: 'Available numbers' })).toBeVisible({
        timeout: 20_000,
      });
      await scan('number search results');
      await page.getByRole('button', { name: 'Buy +1 202 555 0150' }).click();
      await expect(page.getByRole('dialog', { name: 'Buy this number' })).toBeVisible();
      await scan('number purchase confirmation');
    } finally {
      // Frees the caller id claim, pass or fail.
      await page.request.delete('/api/v1/voice/connection');
      await context.close();
    }
    expect(problems).toEqual([]);
  });
}

// ---------------------------------------------------------------------------------------------
// Keyboard and focus

test.describe('keyboard and focus', () => {
  test('Tab reaches Skip to content first, and it moves focus to the main region', async ({
    browser,
  }) => {
    const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
    await page.goto('/contacts');
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
    await context.close();
  });

  async function trapsAndReturns(page: Page, trigger: () => Promise<void>, name: string) {
    const dialog = page.getByRole('dialog', { name });
    await trigger();
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the ${name} dialog on Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Shift+Tab');
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the ${name} dialog on Shift+Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  test('the Add contact dialog traps focus and gives it back', async ({ browser }) => {
    const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
    await page.goto('/contacts');
    const trigger = page.getByRole('button', { name: 'Add contact' }).first();
    await trapsAndReturns(page, () => trigger.click(), 'Add contact');
    await expect(trigger).toBeFocused();
    await context.close();
  });

  test('the Edit contact dialog traps focus and gives it back', async ({ browser }) => {
    const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
    await page.goto(`/contacts/${seededId}`);
    const more = page.getByRole('button', { name: 'More actions' });
    await trapsAndReturns(
      page,
      async () => {
        await more.click();
        await page.getByRole('menuitem', { name: 'Edit contact' }).click();
      },
      'Edit contact',
    );
    await expect(more).toBeFocused();
    await context.close();
  });

  test('the account menu opens with Enter and closes with Escape, returning focus', async ({
    browser,
  }) => {
    const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
    await page.goto('/contacts');
    const trigger = page.getByRole('button', { name: 'Account menu' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await context.close();
  });

  /** Every invalid field is announced: described by visible text, or inside a live region. */
  async function invalidFieldsAreAnnounced(scope: ReturnType<Page['locator']>): Promise<string[]> {
    return scope.locator('[aria-invalid="true"]').evaluateAll((fields) => {
      const lost: string[] = [];
      for (const field of fields) {
        const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const described = ids.some((id) => (document.getElementById(id)?.textContent ?? '').trim());
        const live = field.closest('[aria-live], [role="alert"]') !== null;
        if (!described && !live) {
          lost.push(field.getAttribute('name') ?? field.getAttribute('id') ?? field.tagName);
        }
      }
      return lost;
    });
  }

  test('sign-in field errors are announced', async ({ browser }) => {
    const { context, page } = await frame(browser, {
      theme: 'light',
      width: 1440,
      signedIn: false,
    });
    await page.goto('/sign-in');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
    expect(await invalidFieldsAreAnnounced(page.locator('main'))).toEqual([]);
    await context.close();
  });

  test('Add contact field errors are announced', async ({ browser }) => {
    const { context, page } = await frame(browser, { theme: 'light', width: 1440, signedIn: true });
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'Add contact' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add contact' });
    await dialog.getByRole('button', { name: 'Add contact' }).click();
    await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible();
    expect(await invalidFieldsAreAnnounced(dialog)).toEqual([]);
    await context.close();
  });
});

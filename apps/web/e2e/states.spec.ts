import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { createThrowaway, seedWorkspace } from './completeness/seed';
import {
  addContact,
  fillContactDialog,
  openFromList,
  permissions,
  timeline,
} from './contact-helpers';
import { signUp } from './session';

const SUCCESS_PATTERN = [12, 40, 18];
const WARNING_PATTERN = [30, 60, 30];
const ERROR_PATTERN = [40, 50, 40, 50, 40];

const SERVER_ERROR = JSON.stringify({ data: null, error: { code: 'internal', message: 'boom' } });

/** Records every navigator.vibrate call on window.__vibrations. Must run before navigation. */
async function recordVibrations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: unknown[] = [];
    (window as unknown as { __vibrations: unknown[] }).__vibrations = calls;
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: unknown) => {
        calls.push(pattern);
        return true;
      },
    });
  });
}

const vibrations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vibrations: unknown[] }).__vibrations);

const toastRegion = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text });

/** Answers matching requests of one method with a 500 until `page.unroute(url)`. */
async function failWith500(page: Page, url: RegExp | string, method: string): Promise<void> {
  await page.route(url, (route) =>
    route.request().method() === method
      ? route.fulfill({ status: 500, contentType: 'application/json', body: SERVER_ERROR })
      : route.continue(),
  );
}

test('a successful Add contact vibrates the success pattern and confirms with a toast', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ines Duarte', phone: '+1 202 555 0201' });
  await expect(toastRegion(page, 'Added Ines Duarte.')).toBeVisible();
  expect(await vibrations(page)).toContainEqual(SUCCESS_PATTERN);
});

test('a failed Add contact shows the failure, re-enables the button and vibrates the error pattern', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  await page.goto('/contacts');
  await failWith500(page, '**/api/v1/contacts', 'POST');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await fillContactDialog(page, { name: 'Failing Person', phone: '+1 202 555 0202' });
  const dialog = page.getByRole('dialog', { name: 'Add contact' });
  await expect(dialog.getByRole('alert')).toContainText('We could not save this contact');
  const submit = dialog.getByRole('button', { name: 'Add contact' });
  await expect(submit).toBeEnabled();
  await expect(submit).not.toHaveAttribute('aria-busy', 'true');
  expect(await vibrations(page)).toContainEqual(ERROR_PATTERN);
});

test('going offline mid-save fails cleanly: no hanging spinner, the button comes back, a retry works', async ({
  page,
  context,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add contact' });
  await dialog.getByLabel('Name').fill('Offline Olga');
  await dialog.getByLabel('Phone').fill('+1 202 555 0203');
  await context.setOffline(true);
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await expect(dialog.getByRole('alert')).toContainText('We could not reach KNOQRA');
  const submit = dialog.getByRole('button', { name: 'Add contact' });
  await expect(submit).toBeEnabled();
  await expect(submit).not.toHaveAttribute('aria-busy', 'true');

  await context.setOffline(false);
  await submit.click();
  await expect(dialog).toHaveCount(0);
  await expect(toastRegion(page, 'Added Offline Olga.')).toBeVisible();
});

test('a failed theme save is announced inside a live region that existed before the press', async ({
  page,
}) => {
  await signUp(page);
  await failWith500(page, '**/api/v1/me/prefs', 'PATCH');
  const regions = page.locator('[role="status"]');
  expect(await regions.count()).toBeGreaterThan(0);
  // Tag what exists now; React never removes an attribute it did not set.
  await regions.evaluateAll((nodes) => {
    for (const node of nodes) node.setAttribute('data-before-click', 'true');
  });
  await page
    .getByRole('button', { name: /^Theme:/ })
    .first()
    .click();
  await expect(
    page
      .locator('[role="status"][data-before-click="true"]')
      .filter({ hasText: 'We could not save your theme.' }),
  ).toBeVisible();
});

test('editing a contact confirms, and a failed edit keeps the dialog open with the failure', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Carlos Mena', phone: '+1 202 555 0204' });
  await openFromList(page, 'Carlos Mena');

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });

  const contactUrl = /\/api\/v1\/contacts\/ct_[0-9a-f]{32}$/;
  await failWith500(page, contactUrl, 'PATCH');
  await dialog.getByLabel('Job title').fill('Buyer');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('We could not save this contact');
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  expect(await vibrations(page)).toContainEqual(ERROR_PATTERN);

  await page.unroute(contactUrl);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toastRegion(page, 'Contact updated.')).toBeVisible();
  expect(await vibrations(page)).toContainEqual(SUCCESS_PATTERN);
});

test('archiving and restoring confirm with a toast, and a failed archive says so', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  const id = await createThrowaway(page.request, 'archive');
  await page.goto(`/contacts/${id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Throwaway archive' })).toBeVisible();

  const archiveUrl = /\/api\/v1\/contacts\/ct_[0-9a-f]{32}\/archive$/;
  await failWith500(page, archiveUrl, 'POST');
  const archiveConfirm = page.getByRole('dialog', { name: 'Archive Throwaway archive?' });
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive contact' }).click();
  await archiveConfirm.getByRole('button', { name: 'Archive' }).click();
  await expect(toastRegion(page, 'We could not update this contact. Try again.')).toBeVisible();
  const afterFailure = await vibrations(page);
  expect(afterFailure).toContainEqual(WARNING_PATTERN); // on confirming the destructive dialog
  expect(afterFailure).toContainEqual(ERROR_PATTERN);

  await page.unroute(archiveUrl);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive contact' }).click();
  await archiveConfirm.getByRole('button', { name: 'Archive' }).click();
  await expect(toastRegion(page, 'Archived Throwaway archive.')).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Restore contact' }).click();
  await expect(toastRegion(page, 'Restored Throwaway archive.')).toBeVisible();
});

test('merging confirms with a toast, and a failed merge leaves the dialog open with the failure', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0211' });
  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0212' });
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0212/ }).click();
  const card = permissions(page).getByRole('group', { name: 'Suggested match' });
  await card.getByRole('button', { name: 'Merge Maya Okafor' }).click();
  const confirm = page.getByRole('dialog', { name: 'Merge contacts' });

  const mergeUrl = /\/api\/v1\/contacts\/ct_[0-9a-f]{32}\/merge$/;
  await failWith500(page, mergeUrl, 'POST');
  await confirm.getByRole('button', { name: 'Merge contacts' }).click();
  await expect(confirm.getByRole('alert')).toContainText('We could not merge these contacts');
  await expect(confirm.getByRole('button', { name: 'Merge contacts' })).toBeEnabled();

  await page.unroute(mergeUrl);
  await confirm.getByRole('button', { name: 'Merge contacts' }).click();
  await expect(card).toHaveCount(0);
  await expect(toastRegion(page, 'Merged Maya Okafor into Maya Okafor.')).toBeVisible();
  const calls = await vibrations(page);
  expect(calls).toContainEqual(WARNING_PATTERN);
  expect(calls).toContainEqual(SUCCESS_PATTERN);
});

test('adding a note confirms, and a failed note keeps the text', async ({ page }) => {
  await signUp(page);
  const seed = await seedWorkspace(page.request);
  await page.goto(`/contacts/${seed.empty}`);
  const composer = page.getByRole('textbox', { name: 'Add a note' });
  await composer.fill('Prefers email.');

  const notesUrl = /\/api\/v1\/contacts\/ct_[0-9a-f]{32}\/notes$/;
  await failWith500(page, notesUrl, 'POST');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'We could not save the note' }),
  ).toBeVisible();
  await expect(composer).toHaveValue('Prefers email.');

  await page.unroute(notesUrl);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Prefers email.')).toBeVisible();
  await expect(toastRegion(page, 'Note added.')).toBeVisible();
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('every transition and animation on a page collapses to at most 1ms', async ({ page }) => {
    await signUp(page);
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const longestMs = await page.evaluate(() => {
      const toMs = (value: string) =>
        value
          .split(',')
          .map((part) => {
            const n = Number.parseFloat(part);
            return part.trim().endsWith('ms') ? n : n * 1000;
          })
          .filter((n) => !Number.isNaN(n));
      let max = 0;
      for (const element of document.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        max = Math.max(max, ...toMs(style.transitionDuration), ...toMs(style.animationDuration));
      }
      return max;
    });
    expect(longestMs).toBeLessThanOrEqual(1);
  });

  test('haptics stay silent', async ({ page }) => {
    await recordVibrations(page);
    await signUp(page);
    await page.goto('/contacts');
    await addContact(page, { name: 'Quiet Quentin', phone: '+1 202 555 0205' });
    expect(await vibrations(page)).toEqual([]);
  });
});

test('dismissing a suggested match confirms and vibrates, and a failed dismiss says so', async ({
  page,
}) => {
  await recordVibrations(page);
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Dana Whitlock', phone: '+1 202 555 0221' });
  await addContact(page, { name: 'Dana Whitlock', phone: '+1 202 555 0222' });
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0221/ }).click();
  const card = permissions(page).getByRole('group', { name: 'Suggested match' });
  const dismiss = card.getByRole('button', { name: /is not the same person/ });

  const dismissUrl = /\/api\/v1\/contacts\/ct_[0-9a-f]{32}\/duplicates\/.+$/;
  await page.route(dismissUrl, (route) =>
    route.request().method() !== 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: SERVER_ERROR })
      : route.continue(),
  );
  await dismiss.click();
  await expect(card.getByRole('alert')).toContainText('We could not save that');
  await expect(dismiss).toBeEnabled();
  expect(await vibrations(page)).toContainEqual(ERROR_PATTERN);

  await page.unroute(dismissUrl);
  await dismiss.click();
  await expect(card).toHaveCount(0);
  await expect(toastRegion(page, 'is not the same person.')).toBeVisible();
  expect(await vibrations(page)).toContainEqual(SUCCESS_PATTERN);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a toast clears the bottom navigation', async ({ page }) => {
    await signUp(page);
    await page.goto('/contacts');
    await addContact(page, { name: 'Phone Pia', phone: '+1 202 555 0231' });
    const toast = toastRegion(page, 'Added Phone Pia.');
    await expect(toast).toBeVisible();
    const toastBox = await toast.getByText('Added Phone Pia.').boundingBox();
    const navBox = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
    expect(toastBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    if (toastBox && navBox) expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(navBox.y);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase 2: the shared states wired into each view (Task 8 coverage checklist). One seeded account
// serves these; each test opens its own context so routes and offline mode never leak.

type Seed = Awaited<ReturnType<typeof seedWorkspace>>;

const stateOf = (page: Page, kind: string) => page.locator(`[data-state-kind="${kind}"]`);

/** Answers GET requests to `url` with this status and error code until the page closes. */
async function answerGet(page: Page, url: RegExp, status: number, code: string): Promise<void> {
  await page.route(url, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: { code, message: `${status} from the test` } }),
        })
      : route.continue(),
  );
}

const CONTACT_LIST = /\/api\/v1\/contacts(\?.*)?$/;
const contactUrl = (id: string) => new RegExp(`/api/v1/contacts/${id}$`);

test.describe('phase 2: states in each view', () => {
  test.describe.configure({ timeout: 90_000 });
  let storageState: BrowserContextOptions['storageState'];
  let seed: Seed;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page);
    seed = await seedWorkspace(page.request);
    storageState = await context.storageState();
    await context.close();
  });

  async function open(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await recordVibrations(page);
    return { page, context };
  }

  test('contacts: a 500 shows the error state with Try again, which recovers', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await answerGet(page, CONTACT_LIST, 500, 'internal');
    await page.goto('/contacts');
    const error = stateOf(page, 'error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(
      error.getByRole('heading', { name: 'We could not load your contacts.' }),
    ).toBeVisible();
    await page.unroute(CONTACT_LIST);
    await error.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    await context.close();
  });

  test('contacts: a 403 shows the no-access state without a retry', async ({ browser }) => {
    const { page, context } = await open(browser);
    await answerGet(page, CONTACT_LIST, 403, 'forbidden');
    await page.goto('/contacts');
    const denied = stateOf(page, 'denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText("You don't have access to your contacts.");
    await expect(denied.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await context.close();
  });

  test('contacts: offline, the banner shows and the list says offline until reconnected', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    // Hold the list's first load, go offline, then let it fail as an offline fetch does.
    let mode: 'hold' | 'fail' | 'pass' = 'hold';
    const held: Route[] = [];
    await page.route(CONTACT_LIST, (route) => {
      if (route.request().method() !== 'GET' || mode === 'pass') return route.continue();
      if (mode === 'fail') return route.abort('internetdisconnected');
      held.push(route);
    });
    await page.goto('/contacts');
    await expect.poll(() => held.length).toBeGreaterThan(0);
    const banner = page.getByTestId('offline-banner');
    await expect(banner).toHaveText('');
    await context.setOffline(true);
    await expect(banner).toHaveText("You're offline. Changes will not save until you reconnect.");
    mode = 'fail';
    for (const route of held.splice(0)) await route.abort('internetdisconnected');
    const offline = stateOf(page, 'offline');
    await expect(offline).toBeVisible({ timeout: 15_000 });
    await expect(offline).toContainText("You're offline");
    await context.setOffline(false);
    await expect(banner).toHaveText('');
    mode = 'pass';
    await offline.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    await context.close();
  });

  test('Contact 360: a missing contact is a not-found page with its own h1', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await page.goto('/contacts/ct_00000000000000000000000000000000');
    const missing = stateOf(page, 'not-found');
    await expect(missing).toBeVisible();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: "This contact doesn't exist or isn't in your workspace.",
      }),
    ).toBeVisible();
    // Hidden from 1024px, where the contact list sits beside it, but always in the page.
    await expect(
      page.getByRole('link', { name: 'All contacts', includeHidden: true }),
    ).toBeAttached();
    await context.close();
  });

  test('Contact 360: a 500 shows the error state and a 403 the no-access state', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await answerGet(page, contactUrl(seed.full), 500, 'internal');
    await page.goto(`/contacts/${seed.full}`);
    const error = stateOf(page, 'error');
    await expect(error).toBeVisible();
    await expect(error.getByRole('heading', { level: 1 })).toHaveText(
      'We could not load this contact.',
    );
    await expect(error.getByRole('button', { name: 'Try again' })).toBeVisible();

    await page.unroute(contactUrl(seed.full));
    await answerGet(page, contactUrl(seed.full), 403, 'forbidden');
    await page.reload();
    const denied = stateOf(page, 'denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText("You don't have access to this contact.");
    await context.close();
  });

  test('Contact 360: the timeline shows its empty state, and its 500 and offline states', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await page.goto(`/contacts/${seed.full}`);
    await expect(timeline(page).getByText('Wants a quote for 40 m2 of tile.')).toBeVisible();

    await timeline(page).getByRole('button', { name: 'Calls', exact: true }).click();
    const empty = timeline(page).locator('[data-state-kind="empty"]');
    await expect(empty).toHaveAttribute('role', 'status');
    await expect(
      empty.getByRole('heading', { name: 'No calls with this contact yet.' }),
    ).toBeVisible();

    const timelineUrl = new RegExp(`/api/v1/contacts/${seed.full}/timeline`);
    await answerGet(page, timelineUrl, 500, 'internal');
    await timeline(page).getByRole('button', { name: 'Messages', exact: true }).click();
    await expect(timeline(page).locator('[data-state-kind="error"]')).toContainText(
      'We could not load the timeline.',
      { timeout: 15_000 },
    );

    await page.unroute(timelineUrl);
    await context.setOffline(true);
    await timeline(page).getByRole('button', { name: 'Notes & consent', exact: true }).click();
    await expect(timeline(page).locator('[data-state-kind="offline"]')).toContainText(
      "You're offline",
      { timeout: 15_000 },
    );
    await context.setOffline(false);
    await context.close();
  });

  test('Contact 360: permissions that fail to load show the error state', async ({ browser }) => {
    const { page, context } = await open(browser);
    await answerGet(page, new RegExp(`/api/v1/contacts/${seed.full}/permissions`), 500, 'internal');
    await page.goto(`/contacts/${seed.full}`);
    await expect(permissions(page).locator('[data-state-kind="error"]')).toContainText(
      "We could not load this contact's permissions.",
      { timeout: 15_000 },
    );
    await context.close();
  });

  test('consent: a grant confirms with a warning tap, then a success tap and a toast', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await page.goto(`/contacts/${seed.empty}`);
    await permissions(page).getByRole('button', { name: 'Change SMS consent' }).click();
    await page.getByRole('menuitem', { name: 'Grant consent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Grant consent: SMS' });
    await dialog.getByRole('button', { name: 'Grant consent' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(toastRegion(page, 'SMS consent granted.')).toBeVisible();
    const calls = await vibrations(page);
    expect(calls).toContainEqual(WARNING_PATTERN);
    expect(calls).toContainEqual(SUCCESS_PATTERN);
    await context.close();
  });

  test('do not contact: a failure keeps the dialog, says so, re-enables and taps the error', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await failWith500(page, /\/do-not-contact$/, 'POST');
    await page.goto(`/contacts/${seed.empty}`);
    await permissions(page).getByRole('button', { name: 'Change SMS consent' }).click();
    await page.getByRole('menuitem', { name: 'Do not contact', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Do not contact/ });
    const confirm = dialog.getByRole('button', { name: 'Mark do not contact' });
    await confirm.click();
    await expect(dialog.getByRole('alert')).toContainText('We could not save this change.');
    await expect(confirm).toBeEnabled();
    const calls = await vibrations(page);
    expect(calls).toContainEqual(WARNING_PATTERN);
    expect(calls).toContainEqual(ERROR_PATTERN);
    await context.close();
  });

  test('settings: a failed account load and a 403 show error and no-access states', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    // A 5xx on the account is an outage (the whole page says so); a 4xx is this page's error.
    await answerGet(page, /\/api\/v1\/me$/, 400, 'bad_request');
    await page.goto('/settings');
    await expect(stateOf(page, 'error')).toContainText('We could not load your settings.');
    await page.unroute(/\/api\/v1\/me$/);
    await answerGet(page, /\/api\/v1\/me$/, 403, 'forbidden');
    await page.reload();
    await expect(stateOf(page, 'denied').first()).toContainText(
      "You don't have access to your settings.",
    );
    await context.close();
  });

  test('settings: devices and Voice show their own error, and a lost connection says offline', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await answerGet(page, /\/api\/v1\/voice\/connection$/, 500, 'internal');
    // No answer at all for the device list: the request fails as it would offline.
    await page.route(/\/api\/auth\/list-sessions/, (route) => route.abort('internetdisconnected'));
    await page.goto('/settings');
    await expect(stateOf(page, 'error')).toContainText('We could not load the voice connection.');
    await expect(stateOf(page, 'offline')).toContainText("You're offline", { timeout: 15_000 });
    await context.close();
  });

  test('Today and tasks: a failed load says so, and offline says offline', async ({ browser }) => {
    const { page, context } = await open(browser);
    await answerGet(page, /\/api\/v1\/today\?/, 500, 'internal');
    await page.goto('/');
    await expect(page.getByText("We could not load today's numbers.")).toBeVisible({
      timeout: 15_000,
    });

    await page.goto('/tasks');
    await expect(page.getByRole('tablist', { name: 'Task status' })).toBeVisible();
    await context.setOffline(true);
    await page.getByRole('tab', { name: 'Done' }).click();
    await expect(page.getByText("You're offline, so we could not load your tasks.")).toBeVisible({
      timeout: 15_000,
    });
    await context.setOffline(false);
    await context.close();
  });

  test('import: an unreadable file shows the error state above the drop zone', async ({
    browser,
  }) => {
    const { page, context } = await open(browser);
    await page.goto('/contacts/import');
    // No file yet: the drop zone is the empty state.
    await expect(page.getByLabel('Choose a CSV file')).toBeAttached();
    await page.getByLabel('Choose a CSV file').setInputFiles({
      name: 'empty.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('name,phone\n'),
    });
    const error = stateOf(page, 'error');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(
      error.getByRole('heading', { name: 'We could not read this file.' }),
    ).toBeVisible();
    await expect(page.getByLabel('Choose a CSV file')).toBeAttached();
    await context.close();
  });
});

test('contacts: a workspace with no contacts shows the empty state with Add and Import', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  const empty = stateOf(page, 'empty');
  await expect(empty).toHaveAttribute('role', 'status');
  await expect(empty.getByRole('heading', { name: 'No contacts yet' })).toBeVisible();
  await expect(empty.getByRole('button', { name: 'Add contact' })).toBeVisible();
  await expect(empty.getByRole('link', { name: 'Import CSV' })).toBeVisible();
});

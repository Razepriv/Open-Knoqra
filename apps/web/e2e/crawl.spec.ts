import { test as base, type Cookie, expect, type Page, type TestInfo } from '@playwright/test';
import { isPending, readPendingRoutes } from './completeness/allowlist';
import { filterTargets } from './completeness/controls';
import {
  annotations,
  type Crawl,
  checkLanding,
  crawlControl,
  crawlPage,
  crawlThrowaway,
  flushWatch,
  gotoTarget,
  newCrawl,
  record,
  restore,
  type ViewportName,
} from './completeness/crawler';
import { EXPECTED_RESPONSES } from './completeness/expected-responses';
import { watchPage } from './completeness/guards';
import {
  activate,
  collectControls,
  installProbe,
  noiseMasks,
  waitForSettled,
} from './completeness/probe';
import {
  expandRoutes,
  type RouteTarget,
  readRoutePatterns,
  type SeedIds,
} from './completeness/routes';
import { createThrowaway, seedWorkspace } from './completeness/seed';
import { WEB_ORIGIN } from './ports';
import { signUp, uniqueEmail } from './session';

/**
 * The dead-control crawler. For every route target, at desktop and phone widths, it activates
 * every visible, enabled control and fails on: a dead control, a page-guard problem (console
 * error, unexplained 4xx/5xx, failed request), an unknown internal link, the NotFound screen, or
 * focus not coming back after a dialog or menu closes. The engine is completeness/crawler.ts.
 *
 * Narrow it with KNOQRA_CRAWL_ROUTES (comma-separated patterns or labels), e.g.
 *   KNOQRA_CRAWL_ROUTES='/sign-in,/contacts/$contactId (full)' pnpm exec playwright test crawl
 */

const VIEWPORTS: readonly { name: ViewportName; size: { width: number; height: number } }[] = [
  { name: 'desktop', size: { width: 1440, height: 900 } },
  { name: 'phone', size: { width: 390, height: 844 } },
];
const DESKTOP = { width: 1440, height: 900 };

/** Test titles need targets before the worker has seeded anything; ids are swapped in at run time. */
const PLACEHOLDER_SEED: SeedIds = {
  full: 'seed-full',
  mergeTarget: 'seed-merge-target',
  mergedSource: 'seed-merged-source',
  archived: 'seed-archived',
  empty: 'seed-empty',
};
const PLACEHOLDER_THROWAWAY = 'seed-throwaway';
const CRAWL_TIMEOUT_MS = 20 * 60_000;
/** Pages whose signed-out state must explain itself (no challenge, invalid link). */
const MUST_EXPLAIN = new Set(['/two-factor', '/reset-password']);

const patterns = readRoutePatterns();
const pending = readPendingRoutes();
const targets = filterTargets(
  expandRoutes(patterns, PLACEHOLDER_SEED, PLACEHOLDER_THROWAWAY),
  process.env.KNOQRA_CRAWL_ROUTES,
);

/** signUp waits 5 s for the desk; on a busy shared machine the API can take longer. */
async function signUpPatiently(page: Page, prefix: string): Promise<void> {
  try {
    await signUp(page, { email: uniqueEmail(prefix) });
  } catch {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({
      timeout: 30_000,
    });
  }
}

interface CrawlAccount {
  seed: SeedIds;
  cookies: Cookie[];
}

const test = base.extend<object, { account: CrawlAccount }>({
  account: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: WEB_ORIGIN });
      const page = await context.newPage();
      await signUpPatiently(page, 'crawl');
      const seed = await seedWorkspace(page.request);
      const { cookies } = await context.storageState();
      await context.close();
      await use({ seed, cookies });
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

// Every target and viewport is independent: workers share nothing but their own seeded account.
test.describe.configure({ mode: 'parallel' });
// A crawl is minutes of actions; its trace is huge and slow to write. The problem lines and
// annotations say what failed and where.
test.use({ trace: 'off' });

function finish(crawl: Crawl, testInfo: TestInfo) {
  testInfo.annotations.push(...annotations(crawl));
  crawl.watch.stop();
  expect(crawl.problems, 'crawl problems').toEqual([]);
}

/** A signed-in crawl of one contact page, for the checks that are not route targets. */
async function contactCrawl(
  page: Page,
  account: CrawlAccount,
  viewport: ViewportName,
  id: string,
  label: string,
): Promise<Crawl> {
  await installProbe(page);
  await page.context().addCookies(account.cookies);
  const url = `/contacts/${id}`;
  const target: RouteTarget = {
    pattern: '/contacts/$contactId',
    url,
    auth: 'app',
    label,
    throwaway: false,
  };
  const crawl = newCrawl(page, target, viewport, url, patterns);
  await gotoTarget(crawl);
  return crawl;
}

async function crawlTarget(
  page: Page,
  target: RouteTarget,
  viewport: ViewportName,
  account: CrawlAccount | null,
  testInfo: TestInfo,
) {
  await installProbe(page);
  const url = account
    ? (expandRoutes([{ pattern: target.pattern, auth: target.auth }], account.seed, 'x').find(
        (t) => t.label === target.label,
      )?.url ?? target.url)
    : target.url;
  const crawl = newCrawl(page, target, viewport, url, patterns);
  if (account) await page.context().addCookies(account.cookies);
  if (target.throwaway) await crawlThrowaway(crawl);
  else await crawlPage(crawl, MUST_EXPLAIN.has(target.pattern));
  finish(crawl, testInfo);
}

for (const vp of VIEWPORTS) {
  test.describe(`crawl ${vp.name}`, () => {
    test.use({ viewport: vp.size, isMobile: false });

    for (const target of targets) {
      const owner = pending.find((p) => p.route === target.pattern)?.owner;
      if (target.auth === 'public') {
        test(target.label, async ({ page }, testInfo) => {
          test.setTimeout(CRAWL_TIMEOUT_MS);
          await crawlTarget(page, target, vp.name, null, testInfo);
        });
      } else {
        test(target.label, async ({ page, account }, testInfo) => {
          test.skip(isPending(target.pattern, pending), `pending: ${owner ?? 'unknown'}`);
          test.setTimeout(CRAWL_TIMEOUT_MS);
          await crawlTarget(page, target, vp.name, account, testInfo);
        });
      }
    }

    test('keyboard: Ctrl+K opens the command palette and Escape gives focus back', async ({
      page,
      account,
    }, testInfo) => {
      test.setTimeout(CRAWL_TIMEOUT_MS);
      // A contact page: no palette destination points back at it, so every one must navigate.
      const crawl = await contactCrawl(
        page,
        account,
        vp.name,
        account.seed.full,
        'Ctrl+K on /contacts/$contactId (full)',
      );
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      const bell = page.getByRole('button', { name: /^Notifications/ });
      const open = async () => {
        await bell.focus();
        await page.keyboard.press('ControlOrMeta+k');
        await expect(palette).toBeVisible();
        await waitForSettled(page);
      };

      await open();
      const options = (await collectControls(page, palette)).filter((c) => c.role === 'option');
      expect(options.length, 'the palette lists destinations').toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await expect(bell, 'Escape returns focus to where it was').toBeFocused();

      for (const option of options) {
        await restore(crawl);
        await open();
        flushWatch(crawl, null, []);
        const effects = await activate(page, option, palette);
        crawl.activated += 1;
        if (!effects.includes('navigated')) {
          record(crawl, option, [], `did not navigate (effects: ${effects.join(', ') || 'none'})`);
        }
        await checkLanding(crawl, option, []);
        flushWatch(crawl, option, []);
      }
      finish(crawl, testInfo);
    });
  });
}

/** Adds a probe button: `dead` does nothing, `live` adds text, `fetch404` asks for a missing path. */
async function inject(page: Page, name: string, kind: 'dead' | 'live' | 'fetch404') {
  await page.evaluate(
    ([label, what]) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', () => {
        if (what === 'live') button.after(document.createTextNode('clicked'));
        if (what === 'fetch404') void fetch('/api/v1/__probe');
      });
      document.body.append(button);
    },
    [name, kind] as const,
  );
}

test.describe('crawl session', () => {
  test.use({ viewport: DESKTOP, isMobile: false });

  test('self-check: the probe tells a dead control from a live one', async ({ page }) => {
    await installProbe(page);
    await page.goto('/sign-in');
    await waitForSettled(page);
    await inject(page, 'Probe dead', 'dead');
    await inject(page, 'Probe live', 'live');
    expect(await activate(page, { role: 'button', name: 'Probe dead', nth: 0 })).toEqual([]);
    expect(await activate(page, { role: 'button', name: 'Probe live', nth: 0 })).toEqual(['dom']);
  });

  test('self-check: a ticking clock becomes a noise mask, and dead still reads dead', async ({
    page,
  }) => {
    await installProbe(page);
    await page.goto('/sign-in');
    await waitForSettled(page);
    await page.evaluate(() => {
      const clock = document.createElement('span');
      clock.id = 'probe-clock';
      document.body.append(clock);
      setInterval(() => {
        clock.textContent = String(Date.now());
      }, 150);
    });
    await waitForSettled(page); // runs out: the clock is seen once
    expect(noiseMasks(page).get('/sign-in') ?? []).toEqual([]);
    await waitForSettled(page); // runs out again: now it is noise
    expect(noiseMasks(page).get('/sign-in')).toEqual(['#probe-clock']);
    await inject(page, 'Probe dead', 'dead');
    await inject(page, 'Probe live', 'live');
    expect(await activate(page, { role: 'button', name: 'Probe dead', nth: 0 })).toEqual([]);
    expect(await activate(page, { role: 'button', name: 'Probe live', nth: 0 })).toEqual(['dom']);
  });

  test('self-check: an unexplained 404 from a control is a crawl problem', async ({
    page,
    account,
  }) => {
    const crawl = await contactCrawl(page, account, 'desktop', account.seed.full, 'self-check');
    await inject(page, 'Probe 404', 'fetch404');
    await crawlControl(crawl, [], { role: 'button', name: 'Probe 404', nth: 0 });
    crawl.watch.stop();
    expect(crawl.problems).toEqual([
      expect.stringMatching(
        /^\[self-check @ desktop\] button "Probe 404": HTTP 404 GET .*\/api\/v1\/__probe$/,
      ),
    ]);
  });

  test('self-check: a toast leaving does not make the next control look alive', async ({
    page,
    account,
  }) => {
    const crawl = await contactCrawl(page, account, 'desktop', account.seed.full, 'self-check');
    crawl.watch.stop(); // the forced failure below is the point, not a finding
    // Fail the theme save: ThemeCycle reverts and shows a toast for 3.6 s.
    await page.route('**/api/v1/me/prefs', (route) =>
      route.fulfill({ status: 500, json: { data: null, error: { code: 'probe' } } }),
    );
    await page.getByRole('button', { name: /^Theme: / }).click();
    await expect(page.getByText('We could not save your theme.')).toBeVisible();
    await page.unrouteAll();
    await restore(crawl);
    await expect(page.getByText('We could not save your theme.')).toBeHidden();
    await inject(page, 'Probe dead', 'dead');
    expect(await activate(page, { role: 'button', name: 'Probe dead', nth: 0 })).toEqual([]);
  });

  test('keyboard: Ctrl+Enter in the note composer saves the note', async ({ page, account }) => {
    const crawl = await contactCrawl(page, account, 'desktop', account.seed.full, 'note');
    // A throwaway, so the seeded contact's timeline stays as seeded.
    const throwaway = await createThrowaway(page.request, 'note shortcut');
    crawl.url = `/contacts/${throwaway}`;
    await gotoTarget(crawl);
    const note = page.getByRole('textbox', { name: 'Add a note' });
    await note.fill('Crawler note: saved with Ctrl+Enter.');
    const saved = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith(`/api/v1/contacts/${throwaway}/notes`),
    );
    await note.press('ControlOrMeta+Enter');
    await saved;
    await expect(page.getByText('Crawler note: saved with Ctrl+Enter.').first()).toBeVisible();
    await expect(note).toHaveValue('');
    finish(crawl, test.info());
  });

  test('sign out runs once and lands on /sign-in', async ({ page }) => {
    await installProbe(page);
    const watch = watchPage(page, EXPECTED_RESPONSES);
    await signUpPatiently(page, 'crawl-sign-out');
    await waitForSettled(page);
    await activate(page, { role: 'button', name: 'Account menu', nth: 0 });
    const effects = await activate(
      page,
      { role: 'menuitem', name: 'Sign out', nth: 0 },
      page.getByRole('menu'),
    );
    expect(effects).toContain('navigated');
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(watch.problems()).toEqual([]);
    watch.stop();
  });
});

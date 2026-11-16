import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from '@playwright/test';
import { seedWorkspace } from './completeness/seed';
import { TEST_PASSWORD, uniqueEmail } from './session';

/**
 * Loading outlines: every page shows its own layout-shaped skeleton while its data is held back,
 * the shell outline lines up with the real shell, nothing shifts when content lands (CLS ≤ 0.01)
 * and reduced motion stills the glyphs.
 */

const CLS_BOUND = 0.01;
const SETTLE_MS = 1200;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [
  { name: '1440', size: DESKTOP },
  { name: '390', size: PHONE },
] as const;

/** Set SKELETON_SHOTS=1 to save held-skeleton and loaded screenshots for a visual check. */
const SHOTS = process.env.SKELETON_SHOTS === '1';
const SHOT_DIR = fileURLToPath(new URL('../test-results/skeleton-check/', import.meta.url));
/** SKELETON_SCHEME=dark runs the same checks (and shots) in the dark theme. */
const SCHEME: 'light' | 'dark' = process.env.SKELETON_SCHEME === 'dark' ? 'dark' : 'light';

declare global {
  interface Window {
    __cls: number;
    __shifts: string[];
  }
}

/** Sums layout shifts not caused by input; `window.__cls = 0` starts a new measurement. */
function installClsObserver(): void {
  window.__cls = 0;
  window.__shifts = [];
  const nodeLabel = (node: Node | null): string => {
    if (!(node instanceof Element)) return node ? node.nodeName : 'gone';
    const text = (node.textContent ?? '').trim().slice(0, 30);
    return `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)} "${text}"`;
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
      sources?: {
        node: Node | null;
        previousRect: DOMRectReadOnly;
        currentRect: DOMRectReadOnly;
      }[];
    })[]) {
      if (entry.hadRecentInput) continue;
      window.__cls += entry.value;
      for (const source of entry.sources ?? []) {
        const a = source.previousRect;
        const b = source.currentRect;
        window.__shifts.push(
          `${entry.value.toFixed(4)} ${nodeLabel(source.node)} (${a.x},${a.y},${a.width}x${a.height}) -> (${b.x},${b.y},${b.width}x${b.height})`,
        );
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
}

/** Holds matching requests until released; afterwards they pass straight through. */
class Gate {
  private held: Route[] = [];
  private open = false;

  constructor(
    private readonly page: Page,
    private readonly matches: (url: URL) => boolean,
  ) {}

  async install(): Promise<void> {
    await this.page.route(
      (url) => this.matches(url),
      (route) => {
        if (this.open) return route.fallback();
        this.held.push(route);
      },
    );
  }

  get count(): number {
    return this.held.length;
  }

  release(): void {
    this.open = true;
    for (const route of this.held.splice(0)) void route.fallback().catch(() => {});
  }
}

const isSession = (url: URL) => url.pathname === '/api/auth/get-session';
const isAppData = (url: URL) => url.pathname.startsWith('/api/v1/');
const isEntry = (url: URL) => url.pathname === '/src/main.tsx';

async function resetCls(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__cls = 0;
    window.__shifts = [];
  });
}

/** The CLS since the last reset; the shifted elements go into the test's annotations. */
async function readCls(page: Page, name: string): Promise<number> {
  const { cls, shifts } = await page.evaluate(() => ({
    cls: window.__cls,
    shifts: window.__shifts,
  }));
  test.info().annotations.push({ type: 'cls', description: `${name}: ${cls.toFixed(4)}` });
  for (const shift of shifts) test.info().annotations.push({ type: 'shift', description: shift });
  return cls;
}

/** No glyph placeholder left on the page, then a moment for reveals to finish. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-ascii-skeleton]')).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(SETTLE_MS);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

/** Two boxes line up within a pixel; `skip` names the edges a skeleton cannot know. */
function expectSameBox(
  name: string,
  skeleton: { x: number; y: number; width: number; height: number },
  real: { x: number; y: number; width: number; height: number },
  skip: ReadonlyArray<'y' | 'height'> = [],
): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if ((skip as readonly string[]).includes(key)) continue;
    const message = `${name} ${key}: ${skeleton[key]} vs ${real[key]}`;
    expect(Math.abs(skeleton[key] - real[key]), message).toBeLessThanOrEqual(1);
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------------------------
// Signed-in pages

/**
 * A block the outline draws and the page later fills. The outline is a different set of nodes, so
 * Layout Instability (CLS) cannot see the swap; the anchor check measures it instead.
 */
interface Anchor {
  /** data-skeleton-part on the outline (its first match). */
  part: string;
  /** The page's matching block once it has loaded. */
  real: (page: Page) => Locator;
  /** Also compare the height (blocks of fixed height). */
  height?: boolean;
  /** Only from this viewport width up (the block is hidden below it). */
  minWidth?: number;
}

/** The inbound SMS seedWorkspace sends, shown in the Inbox thread. */
const SEEDED_MESSAGE = 'Can you send the tile quote before Friday?';

/** How far an outline block may sit from the real one, in px. */
const ANCHOR_PX = 4;

type Box = { x: number; y: number; width: number; height: number };

function expectNear(name: string, outline: Box, real: Box, keys: readonly (keyof Box)[]): void {
  for (const key of keys) {
    const message = `${name} ${key}: outline ${outline[key].toFixed(1)} vs page ${real[key].toFixed(1)}`;
    expect(Math.abs(outline[key] - real[key]), message).toBeLessThanOrEqual(ANCHOR_PX);
  }
}

const anchorKeys = (anchor: Anchor): (keyof Box)[] =>
  anchor.height ? ['x', 'y', 'width', 'height'] : ['x', 'y', 'width'];

interface AppRoute {
  id: string;
  path: (seed: Seed) => string;
  /** Page ribbon at 1280px and up. */
  ribbon: boolean;
  ready: (page: Page) => Promise<void>;
  /** The page's first panel and header blocks, outline against page. */
  anchors: readonly Anchor[];
  /**
   * A load shift the page itself causes at this viewport (not the outline): the CLS is still
   * measured and annotated, but not asserted. Each entry names the defect to fix.
   */
  knownShift?: Partial<Record<(typeof VIEWPORTS)[number]['name'], string>>;
}

const inMain = (page: Page) => page.locator('#main');

type Seed = Awaited<ReturnType<typeof seedWorkspace>> & { conversation: string };

const APP_ROUTES: readonly AppRoute[] = [
  {
    id: 'today',
    path: () => '/',
    ribbon: true,
    ready: async (page) => {
      await expect(page.locator('[data-widget]')).toHaveCount(4);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
    anchors: [
      { part: 'today-header', real: (page) => inMain(page).locator('header').first() },
      {
        part: 'week-grid',
        real: (page) => page.locator('section[aria-labelledby="week-grid-title"]'),
      },
      { part: 'widget', real: (page) => page.locator('[data-widget]').first() },
    ],
  },
  {
    id: 'tasks',
    path: () => '/tasks',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByText('Nothing due. Add a task, or enjoy the quiet.')).toBeVisible();
    },
    anchors: [
      { part: 'tasks-panel', real: (page) => inMain(page).locator('[aria-label="Tasks"]') },
      {
        part: 'task-form',
        real: (page) => page.locator('form[aria-label="Add a task"]'),
        height: true,
      },
      {
        part: 'tabs',
        real: (page) => page.getByRole('tablist', { name: 'Task status' }),
        height: true,
      },
    ],
  },
  {
    id: 'contacts',
    path: () => '/contacts',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    },
    anchors: [
      { part: 'list-panel', real: (page) => page.getByRole('region', { name: 'People' }) },
      {
        part: 'search',
        real: (page) => page.getByRole('searchbox', { name: 'Search contacts' }).locator('..'),
        height: true,
      },
      {
        part: 'row',
        real: (page) => page.getByRole('list', { name: 'Contacts' }).getByRole('listitem').first(),
        height: true,
      },
    ],
  },
  {
    id: 'contact-360',
    path: (seed) => `/contacts/${seed.full}`,
    ribbon: true,
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: 'Marisol Quintero', level: 1 })).toBeVisible();
      await expect(page.getByText('Wants a quote for 40 m2 of tile.')).toBeVisible();
    },
    anchors: [
      {
        part: 'list-panel',
        real: (page) => page.getByRole('region', { name: 'People' }),
        minWidth: 1024,
      },
      { part: 'profile-header', real: (page) => page.locator('[data-anchor="profile-header"]') },
      // Call, WhatsApp and SMS stacked at the header's right (below 640px they wrap under the
      // chips, whose rows follow the contact's details).
      {
        part: 'profile-actions',
        real: (page) => page.locator('[data-anchor="profile-actions"]'),
        height: true,
        minWidth: 1024,
      },
      // Below 1024px the header's chips wrap to as many rows as the contact has details, so
      // the timeline under it is checked only where the header is one row.
      {
        part: 'timeline',
        real: (page) => page.getByRole('region', { name: 'Timeline' }),
        minWidth: 1024,
      },
    ],
  },
  {
    id: 'contacts-import',
    path: () => '/contacts/import',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
    },
    anchors: [
      {
        part: 'step-list',
        real: (page) => page.getByRole('list', { name: 'Import progress steps' }),
        height: true,
      },
      { part: 'upload-panel', real: (page) => page.locator('[data-anchor="import-upload"]') },
    ],
  },
  {
    id: 'settings',
    path: () => '/settings',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByLabel('Name')).toBeVisible();
      await expect(page.getByRole('list', { name: 'Signed-in devices' })).toBeVisible();
    },
    anchors: [
      {
        part: 'settings-header',
        real: (page) => page.getByRole('heading', { name: 'Settings', level: 1 }).locator('..'),
        height: true,
      },
      {
        part: 'profile',
        real: (page) => page.locator('section[aria-labelledby="profile-heading"]').locator('..'),
      },
      {
        part: 'security',
        real: (page) => page.locator('section[aria-labelledby="security-heading"]').locator('..'),
        minWidth: 1024,
      },
    ],
  },
  // Pages whose outline comes from their own route: the shell draws it while the session check
  // runs, with the page's ribbon where the page has one (no anchors: the shell checks cover them).
  {
    id: 'calls',
    path: () => '/calls',
    ribbon: true,
    ready: async (page) => {
      await expect(page.getByRole('tablist', { name: 'Calls' })).toBeVisible();
    },
    anchors: [],
  },
  {
    id: 'inbox',
    path: () => '/inbox',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByRole('list', { name: 'Conversations' })).toBeVisible();
      await expect(page.getByText('Pick a conversation.')).toBeVisible();
    },
    anchors: [],
    // On a phone the list stacks above the conversation, and the outline draws more rows than a
    // one-thread workspace has, so what is below the list moves up when the rows arrive.
    knownShift: {
      '390': 'Inbox list height on a phone follows the row count (outline draws a fixed set)',
    },
  },
  {
    id: 'inbox-thread',
    path: (seed) => `/inbox?thread=${seed.conversation}`,
    ribbon: true,
    ready: async (page) => {
      await expect(
        page.locator('[aria-label="Conversation"]').getByText(SEEDED_MESSAGE).first(),
      ).toBeVisible();
    },
    anchors: [],
    // On a phone the list stacks above the conversation, and the outline draws more rows than a
    // one-thread workspace has, so what is below the list moves up when the rows arrive.
    knownShift: {
      '390': 'Inbox list height on a phone follows the row count (outline draws a fixed set)',
    },
  },
  {
    id: 'usage',
    path: () => '/usage',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeAttached();
    },
    anchors: [],
  },
  {
    id: 'numbers',
    path: () => '/numbers',
    ribbon: false,
    ready: async (page) => {
      await expect(page.getByRole('heading', { level: 1, name: 'Numbers' })).toBeVisible();
    },
    anchors: [],
  },
];

let storageState: BrowserContextOptions['storageState'];
let seed: Seed;

// No traces here: the outlines animate dozens of glyph canvases, and flushing that trace at
// context close outlasted the test timeout. Failures still report boxes, CLS and shift sources.
test.use({ trace: 'off' });

test.describe('signed-in pages', () => {
  // Each test walks three loading phases; the first also waits for Vite to compile the app.
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async ({ browser }) => {
    // Signing up and seeding a whole workspace takes a while on a busy machine.
    test.setTimeout(120_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    // As session.signUp, with room for a slow API: this hook is setup, not what is under test.
    await page.goto('/sign-up');
    await page.getByLabel('Name').fill('Ana Silva');
    await page.getByLabel('Email').fill(uniqueEmail('skeletons'));
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({
      timeout: 60_000,
    });
    seed = { ...(await seedWorkspace(page.request)), conversation: '' };
    // The seeded inbound SMS lands through the fake provider's webhook; wait for its thread.
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/v1/conversations');
          const body = (await response.json()) as { data?: { items?: { id: string }[] } };
          seed.conversation = body.data?.items?.[0]?.id ?? '';
          return seed.conversation;
        },
        { timeout: 30_000 },
      )
      .not.toBe('');
    storageState = await context.storageState();
    await context.close();
  });

  for (const route of APP_ROUTES) {
    for (const viewport of VIEWPORTS) {
      test(`${route.id} at ${viewport.name}: outline, shell alignment and no shift`, async ({
        browser,
      }) => {
        await checkAppRoute(browser, route, viewport);
      });
    }
  }

  test('reduced motion stills the skeleton glyphs', async ({ browser }) => {
    const still = await glyphSamples(browser, 'reduce');
    expect(still.canvases).toBe(0);
    expect(still.first.equals(still.second)).toBe(true);
    // Control: with motion allowed the shimmer runs, so the samples above prove something.
    const moving = await glyphSamples(browser, 'no-preference');
    expect(moving.canvases).toBeGreaterThan(0);
  });

  test('the bell list shows notification rows while it loads', async ({ browser }) => {
    const context = await browser.newContext({ storageState, viewport: DESKTOP });
    const page = await context.newPage();
    const feed = new Gate(page, (url) => url.pathname.startsWith('/api/v1/notifications'));
    await feed.install();
    await page.goto('/contacts');
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const outline = page.locator('[data-skeleton="bell-list"]');
    await expect(outline).toBeVisible();
    await expect(outline.getByRole('status', { name: 'Loading notifications' })).toHaveCount(1);
    feed.release();
    await expect(page.getByText("You're all caught up.")).toBeVisible();
    await expect(outline).toHaveCount(0);
    await context.close();
  });

  test('palette results show item rows while contacts are searched', async ({ browser }) => {
    const context = await browser.newContext({ storageState, viewport: DESKTOP });
    const page = await context.newPage();
    await page.goto('/contacts');
    await expect(page.getByRole('list', { name: 'Contacts' })).toBeVisible();
    const search = new Gate(
      page,
      (url) => url.pathname === '/api/v1/contacts' && url.searchParams.has('q'),
    );
    await search.install();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Command palette' }).fill('Marisol');
    const outline = page.locator('[data-skeleton="palette-results"]');
    await expect(outline).toBeVisible();
    // The listbox holds only options and groups; the search is announced beside the input.
    const listbox = page.getByRole('listbox');
    await expect(listbox.getByRole('status')).toHaveCount(0);
    await expect(outline).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Searching contacts' })).toHaveCount(1);
    await expect.poll(() => search.count).toBeGreaterThan(0);
    search.release();
    await expect(page.getByRole('option', { name: /Marisol Quintero/ })).toBeVisible();
    await expect(outline).toHaveCount(0);
    await context.close();
  });
});

async function checkAppRoute(
  browser: Browser,
  route: AppRoute,
  viewport: (typeof VIEWPORTS)[number],
): Promise<void> {
  const context = await browser.newContext({
    storageState,
    viewport: viewport.size,
    colorScheme: SCHEME,
  });
  const page = await context.newPage();
  await page.addInitScript(installClsObserver);
  const entry = new Gate(page, isEntry);
  const session = new Gate(page, isSession);
  const data = new Gate(page, isAppData);
  await entry.install();
  await session.install();
  await data.install();

  // Before any script runs: the static shell outline from index.html.
  await page.goto(route.path(seed), { waitUntil: 'commit' });
  await expect(page.locator('#root [data-skeleton="shell"]')).toBeVisible();
  const staticShell = {
    rail: await box(page.locator('#root [data-skeleton-part="rail"]')),
    top: await box(page.locator('#root [data-skeleton-part="top-bar"]')),
  };
  entry.release();

  // The session check is pending: the shell outline with this page's outline in the one main.
  const shell = page.locator('[data-skeleton="shell"]');
  await expect(shell.locator(`[data-skeleton="${route.id}"]`)).toBeVisible();
  await expect(shell.locator('[data-skeleton-part="rail-circle"]')).toHaveCount(7);
  await expect(shell.locator('[data-skeleton-part="top-bar"]')).toBeVisible();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(1);
  const ribbon = shell.locator('[data-skeleton-part="ribbon"]');
  await expect(ribbon).toHaveCount(route.ribbon ? 1 : 0);
  if (route.ribbon) {
    // The ribbon is a third pane only from 1280px; below that it is a drawer.
    expect(await ribbon.isVisible()).toBe(viewport.size.width >= 1280);
  }
  // The outline never scrolls sideways (the real page does not either).
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.size.width,
  );
  const outline = {
    rail: await box(shell.locator('[data-skeleton-part="rail"]')),
    top: await box(shell.locator('[data-skeleton-part="top-bar"]')),
    main: await box(shell.locator('main')),
  };
  const anchors = route.anchors.filter((a) => viewport.size.width >= (a.minWidth ?? 0));
  const anchorBoxes = new Map<string, Box>();
  for (const anchor of anchors) {
    anchorBoxes.set(
      anchor.part,
      await box(shell.locator(`main [data-skeleton-part="${anchor.part}"]`).first()),
    );
  }
  await shot(page, `${route.id}-skeleton-${viewport.name}-${SCHEME}`);

  // From here until the page settles, nothing may shift.
  await resetCls(page);
  session.release();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  // Released requests still go through the local API, which can be slow on a shared machine.
  await expect(nav).toBeVisible({ timeout: 15_000 });
  const topBar = page.locator('header', {
    has: page.getByRole('button', { name: /^Notifications/ }),
  });
  await expect
    .poll(async () => Math.round((await box(page.locator('#main'))).width))
    .toBe(Math.round(outline.main.width));
  // Below 1024px the rail is a bar after the page, so its y follows the page's length.
  expectSameBox('rail', outline.rail, await box(nav), viewport.size.width < 1024 ? ['y'] : []);
  expectSameBox('top bar', outline.top, await box(topBar));
  expectSameBox('main', outline.main, await box(page.locator('#main')), ['height']);

  data.release();
  await route.ready(page);
  await settle(page);
  const cls = await readCls(page, `${route.id}@${viewport.name}`);
  const known = route.knownShift?.[viewport.name];
  if (known) test.info().annotations.push({ type: 'known shift', description: known });
  else expect(cls, `CLS on ${route.id} at ${viewport.name}`).toBeLessThanOrEqual(CLS_BOUND);

  // The outline's blocks sit where the loaded page put them (the swap CLS cannot see).
  for (const anchor of anchors) {
    const drawn = anchorBoxes.get(anchor.part);
    if (!drawn) throw new Error(`no outline box for ${anchor.part}`);
    expectNear(anchor.part, drawn, await box(anchor.real(page).first()), anchorKeys(anchor));
  }
  // So did the static outline's frame. Its rail is as tall as the window, the real one as the page.
  const narrow = viewport.size.width < 1024;
  expectNear(
    'static rail',
    staticShell.rail,
    await box(nav),
    narrow ? ['x', 'width', 'height'] : ['x', 'y', 'width'],
  );
  expectNear('static top bar', staticShell.top, await box(topBar), ['x', 'y', 'width', 'height']);
  await shot(page, `${route.id}-loaded-${viewport.name}-${SCHEME}`);
  await context.close();
}

/** Two pictures of the held Contacts outline, 300ms apart, and how many shimmer canvases it has. */
async function glyphSamples(browser: Browser, reducedMotion: 'reduce' | 'no-preference') {
  const context = await browser.newContext({ storageState, viewport: DESKTOP, reducedMotion });
  const page = await context.newPage();
  const session = new Gate(page, isSession);
  await session.install();
  await page.goto('/contacts');
  const outline = page.locator('[data-skeleton="contacts"]');
  await expect(outline).toBeVisible();
  await page.waitForTimeout(400);
  const canvases = await outline.locator('[data-ascii-skeleton] canvas').count();
  const first = await outline.screenshot({ animations: 'allow' });
  await page.waitForTimeout(300);
  const second = await outline.screenshot({ animations: 'allow' });
  session.release();
  await context.close();
  return { canvases, first, second };
}

// ---------------------------------------------------------------------------------------------
// Auth pages

interface AuthRoute {
  id: string;
  path: string;
  label: string;
  /** The route checks the session before rendering, so its React outline shows while it waits. */
  checksSession: boolean;
  ready: (page: Page) => Promise<void>;
}

const AUTH_ROUTES: readonly AuthRoute[] = [
  {
    id: 'sign-in',
    path: '/sign-in',
    label: 'Loading sign in',
    checksSession: true,
    ready: (page) => expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible(),
  },
  {
    id: 'sign-up',
    path: '/sign-up',
    label: 'Loading sign up',
    checksSession: true,
    ready: (page) => expect(page.getByRole('button', { name: 'Create account' })).toBeVisible(),
  },
  {
    id: 'forgot-password',
    path: '/forgot-password',
    label: 'Loading password reset',
    checksSession: false,
    ready: (page) => expect(page.getByLabel('Email')).toBeVisible(),
  },
  {
    id: 'reset-password',
    path: '/reset-password?token=e2e-skeleton-token',
    label: 'Loading password reset',
    checksSession: false,
    ready: (page) => expect(page.getByLabel('New password', { exact: true })).toBeVisible(),
  },
  {
    id: 'two-factor',
    path: '/two-factor',
    label: 'Loading two-factor check',
    checksSession: true,
    ready: (page) => expect(page.getByRole('button', { name: 'Verify' })).toBeVisible(),
  },
];

interface AuthBoxes {
  name: string;
  hero: Box;
  column: Box;
  field: Box;
}

/** The hero panel, the form column and the first field of an auth outline. */
async function authBoxes(scope: Locator, name: string): Promise<AuthBoxes> {
  return {
    name,
    hero: await box(scope.locator('[data-skeleton-part="auth-hero"]')),
    column: await box(scope.locator('[data-skeleton-part="auth-form-column"]')),
    field: await box(scope.locator('[data-skeleton-part="field"]').first()),
  };
}

/** The same three blocks on the loaded page (AuthLayout: hero panel, form panel's column). */
async function realAuthBoxes(page: Page): Promise<AuthBoxes> {
  return {
    name: 'page',
    hero: await box(page.locator('main > div').nth(0)),
    column: await box(page.locator('main > div').nth(1).locator('> div')),
    field: await box(page.locator('main input:not([type="checkbox"])').first()),
  };
}

/**
 * Wide, the form column is centred beside the hero, so its whole box must match. Narrow, it sits
 * under the hero, whose height follows the headline's wrapping, so there the column is compared
 * without its y and the first field by its offset inside the column.
 */
function expectAuthNear(drawn: AuthBoxes, real: AuthBoxes, width: number): void {
  expectNear(`${drawn.name} hero`, drawn.hero, real.hero, ['x', 'y', 'width']);
  const wide = width >= 1024;
  expectNear(
    `${drawn.name} form column`,
    drawn.column,
    real.column,
    wide ? ['x', 'y', 'width', 'height'] : ['x', 'width', 'height'],
  );
  const offset = (b: AuthBoxes): Box => ({ ...b.field, y: b.field.y - b.column.y });
  expectNear(`${drawn.name} first field`, offset(drawn), offset(real), [
    'x',
    'y',
    'width',
    'height',
  ]);
}

test.describe('auth pages', () => {
  test.describe.configure({ timeout: 60_000 });
  for (const route of AUTH_ROUTES) {
    for (const viewport of VIEWPORTS) {
      test(`${route.id} at ${viewport.name}: outline before and after scripts, no shift`, async ({
        browser,
      }) => {
        const context = await browser.newContext({ viewport: viewport.size, colorScheme: SCHEME });
        const page = await context.newPage();
        await page.addInitScript(installClsObserver);
        const entry = new Gate(page, isEntry);
        const session = new Gate(page, isSession);
        await entry.install();
        await session.install();

        await page.goto(route.path, { waitUntil: 'commit' });
        await expect(page.locator(`#root [data-skeleton="${route.id}"]`)).toBeVisible();
        const drawn = [await authBoxes(page.locator('#root'), 'static outline')];
        await shot(page, `${route.id}-static-${viewport.name}-${SCHEME}`);
        await resetCls(page);
        entry.release();

        if (route.checksSession) {
          const outline = page.locator(`main[data-skeleton="${route.id}"]`);
          await expect(outline).toBeVisible();
          await expect(page.getByRole('main')).toHaveCount(1);
          await expect(page.getByRole('status')).toHaveCount(1);
          await expect(page.getByRole('status', { name: route.label })).toHaveCount(1);
          drawn.push(await authBoxes(outline, 'outline'));
          await shot(page, `${route.id}-skeleton-${viewport.name}-${SCHEME}`);
          session.release();
        }
        await route.ready(page);
        await settle(page);
        const cls = await readCls(page, `${route.id}@${viewport.name}`);
        expect(cls, `CLS on ${route.id} at ${viewport.name}`).toBeLessThanOrEqual(CLS_BOUND);
        const real = await realAuthBoxes(page);
        for (const outline of drawn) expectAuthNear(outline, real, viewport.size.width);
        await shot(page, `${route.id}-loaded-${viewport.name}-${SCHEME}`);
        await context.close();
      });
    }
  }
});

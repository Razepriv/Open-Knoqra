import { type ElementHandle, expect, type Locator, type Page, type Route } from '@playwright/test';
import { WEB_ORIGIN } from '../ports';
import {
  type ControlRef,
  controlKey,
  describeControl,
  type Effect,
  formatProblem,
  isDestructive,
  isOutward,
  linkProblem,
} from './controls';
import { EXPECTED_RESPONSES } from './expected-responses';
import { type PageWatch, watchPage } from './guards';
import { findKnownDefect } from './known-defects';
import {
  activate,
  collectControls,
  forgetNoise,
  locateControl,
  noiseMasks,
  refusedNoise,
  waitForLoaded,
  waitForSettled,
  waitForToasts,
} from './probe';
import { matchesKnownRoute, type RoutePattern, type RouteTarget } from './routes';
import { createThrowaway } from './seed';

/**
 * The dead-control crawler's engine: activate a control, judge what it did, open what it opened
 * and crawl inside, and put the page back. crawl.spec.ts drives it per route target and viewport.
 */

export type ViewportName = 'desktop' | 'phone';

export const NOT_FOUND = 'There is nothing at this address.';
/** Controls inside a container are crawled; containers inside those once more; no deeper. */
const MAX_DEPTH = 2;
/** Dialogs that hold a page region rather than a form: everything inside them is crawled. */
const PANEL_TRIGGERS = new Set(['Open context']);
/** Inside menus only these are activated (and buttons too inside modal dialogs). */
const INNER_ROLES = new Set(['menuitem', 'tab', 'option']);
const SIGN_OUT = /^sign out$/i;
const OVERLAY = '[role="menu"], [role="dialog"], [role="alertdialog"]';
const STEP_TIMEOUT_MS = 4_000;
const DEAD =
  'dead: no navigation, request, DOM change, focus move, dialog, expansion, download, popup or clipboard write';

export interface Crawl {
  page: Page;
  target: RouteTarget;
  viewport: ViewportName;
  patterns: readonly RoutePattern[];
  url: string;
  /** Where `url` settled (after any redirect); restore goes back whenever the page leaves it. */
  landed: string;
  watch: PageWatch;
  problems: string[];
  known: string[];
  activated: number;
  external: number;
  destructiveCancelled: number;
  confirmedNames: string[];
  /** Destructive by name, but opened no confirmation and wrote nothing (a disclosure, say). */
  noConfirmNeeded: string[];
  /** Outward controls (send, call, buy, release): run with writes blocked, dialogs cancelled. */
  outward: string[];
  deferred: string[];
  currentNoops: string[];
}

interface Opened {
  scope: Locator | undefined;
  triggers: ElementHandle[];
  /** The scope is a dialog: every write from inside it is blocked, so seed data never changes. */
  inDialog: boolean;
  /** Disclosures opened on the way; closed again afterwards, since they rename themselves. */
  disclosures: ElementHandle[];
}

/** Closes disclosures left open ("Hide …"), so the next reopen finds them by their closed name. */
async function collapse(disclosures: readonly ElementHandle[]) {
  for (const handle of [...disclosures].reverse()) {
    if ((await handle.getAttribute('aria-expanded').catch(() => null)) === 'true') {
      await handle.click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    }
  }
}

export function newCrawl(
  page: Page,
  target: RouteTarget,
  viewport: ViewportName,
  url: string,
  patterns: readonly RoutePattern[],
): Crawl {
  return {
    page,
    target,
    viewport,
    patterns,
    url,
    landed: url,
    watch: watchPage(page, EXPECTED_RESPONSES),
    problems: [],
    known: [],
    activated: 0,
    external: 0,
    destructiveCancelled: 0,
    confirmedNames: [],
    noConfirmNeeded: [],
    outward: [],
    deferred: [],
    currentNoops: [],
  };
}

export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  return (text.replace(/\u001b\[[0-9;]*m/g, '').split('\n')[0] ?? '').slice(0, 200);
}

export function record(
  crawl: Crawl,
  control: ControlRef | null,
  path: readonly ControlRef[],
  problem: string,
) {
  const line = formatProblem(crawl.target.label, crawl.viewport, control, path, problem);
  const known = findKnownDefect({
    target: crawl.target.label,
    viewport: crawl.viewport,
    control: describeControl(control, path),
    problem,
  });
  if (known) crawl.known.push(`${line} [known, routed: ${known.ticket}]`);
  else crawl.problems.push(line);
}

/** Moves the page-guard findings so far onto `control`, and starts afresh. */
export function flushWatch(crawl: Crawl, control: ControlRef | null, path: readonly ControlRef[]) {
  for (const problem of crawl.watch.problems()) record(crawl, control, path, problem);
  crawl.watch.reset();
}

function overlays(page: Page): Locator {
  return page.locator(OVERLAY).filter({ visible: true });
}

/** Remembers which overlays are open now (in the page, without touching the DOM). */
async function rememberOverlays(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    (window as unknown as { __kqOverlays?: Set<Element> }).__kqOverlays = new Set(
      document.querySelectorAll(selector),
    );
  }, OVERLAY);
}

/**
 * The newest visible overlay that was not open at `rememberOverlays` (a menu item can close its
 * menu and open a dialog, so counting is not enough), or null.
 */
async function newOverlay(page: Page): Promise<Locator | null> {
  const index = await page
    .evaluate((selector) => {
      const old = (window as unknown as { __kqOverlays?: Set<Element> }).__kqOverlays ?? new Set();
      const all = [...document.querySelectorAll(selector)];
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const el = all[i] as Element;
        const shown =
          el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        if (shown && !old.has(el)) return i;
      }
      return -1;
    }, OVERLAY)
    .catch(() => -1);
  return index < 0 ? null : page.locator(OVERLAY).nth(index);
}

async function closeOverlays(page: Page) {
  for (let i = 0; i < 4 && (await overlays(page).count()) > 0; i += 1) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

export async function gotoTarget(crawl: Crawl) {
  forgetNoise(crawl.page);
  await crawl.page.goto(crawl.url, { timeout: 60_000 });
  await waitForSettled(crawl.page);
  crawl.landed = crawl.page.url();
}

/** Back to the target with nothing open, no toast on screen and the page quiet. */
export async function restore(crawl: Crawl) {
  if (crawl.page.url() !== crawl.landed) {
    await gotoTarget(crawl);
  } else {
    await closeOverlays(crawl.page);
  }
  await waitForToasts(crawl.page);
  await waitForSettled(crawl.page);
}

export async function checkLanding(
  crawl: Crawl,
  control: ControlRef | null,
  path: readonly ControlRef[],
) {
  const url = new URL(crawl.page.url());
  if (
    url.origin === WEB_ORIGIN &&
    !url.pathname.startsWith('/api/') &&
    !matchesKnownRoute(url.pathname, [...crawl.patterns])
  ) {
    record(crawl, control, path, `navigates to unknown route ${url.pathname}`);
  }
  const notFound = crawl.page.getByRole('heading', { name: NOT_FOUND });
  if (await notFound.isVisible().catch(() => false)) {
    record(crawl, control, path, `shows the NotFound screen at ${url.pathname}`);
  }
}

export async function checkLinks(crawl: Crawl, scope: Locator, path: readonly ControlRef[]) {
  const links = await scope.locator('a[href]').evaluateAll((anchors) =>
    anchors.map((a) => {
      const raw = a.getAttribute('href') ?? '';
      const text = (a.textContent ?? '').trim() || a.getAttribute('aria-label') || raw;
      return {
        href: raw.trim() === '' || /^javascript:/i.test(raw) ? raw : (a as HTMLAnchorElement).href,
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
        text,
      };
    }),
  );
  const seen = new Set<string>();
  for (const link of links) {
    const key = `${link.href}|${link.target}|${link.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const problem = linkProblem(link, WEB_ORIGIN, crawl.patterns);
    if (problem) record(crawl, { role: 'link', name: link.text, nth: 0 }, path, problem);
  }
}

/**
 * Counts writes (non-GET API requests) while active. With `block`, aborts them too ("aborted",
 * which the guards ignore); the attempt still fires a `request` event, so it still counts as an
 * effect.
 */
async function watchWrites(page: Page, block: boolean) {
  let attempts = 0;
  const handler = (route: Route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'HEAD') return route.fallback();
    attempts += 1;
    return block ? route.abort('aborted') : route.fallback();
  };
  await page.route('**/api/**', handler);
  return {
    attempts: () => attempts,
    release: () => page.unroute('**/api/**', handler),
  };
}

/** True once focus is back on the first of these still in the page (the trigger, or its own). */
async function focusReturned(candidates: (ElementHandle | null)[]): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let verdict: boolean | null = null;
    for (const handle of candidates) {
      if (!handle) continue;
      const result = await handle
        .evaluate((el) =>
          el.isConnected
            ? el === document.activeElement || el.contains(document.activeElement)
            : null,
        )
        .catch(() => null);
      if (result !== null) {
        verdict = result;
        break;
      }
    }
    if (verdict === null || verdict) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function isModal(overlay: Locator): Promise<boolean> {
  return overlay.evaluate((el) =>
    [...document.body.children].some(
      (child) =>
        !child.contains(el) &&
        (child.getAttribute('aria-hidden') === 'true' || child.hasAttribute('inert')),
    ),
  );
}

async function isDialog(overlay: Locator): Promise<boolean> {
  const role = await overlay.getAttribute('role', { timeout: STEP_TIMEOUT_MS }).catch(() => null);
  return role === 'dialog' || role === 'alertdialog';
}

async function isPopupTrigger(locator: Locator, control: ControlRef): Promise<boolean> {
  if (PANEL_TRIGGERS.has(control.name)) return true;
  const popup = await locator.getAttribute('aria-haspopup', { timeout: STEP_TIMEOUT_MS });
  return popup !== null && popup !== 'false';
}

/** An inline disclosure: aria-expanded without a popup. What it reveals stays in the same scope. */
async function isDisclosure(handle: ElementHandle<Element>): Promise<boolean> {
  return handle
    .evaluate((el) => el.hasAttribute('aria-expanded') && !el.hasAttribute('aria-haspopup'))
    .catch(() => false);
}

/** Opens one trigger; returns the overlay it opened, `'inline'` for a disclosure, or null. */
async function openTrigger(
  page: Page,
  locator: Locator,
  handle: ElementHandle<Element>,
): Promise<Locator | 'inline' | null> {
  const expanded = async () => (await handle.getAttribute('aria-expanded')) === 'true';
  const disclosure = await isDisclosure(handle);
  // Restore leaves a disclosure as it was, so only click it when it is closed.
  if (disclosure && (await expanded())) return 'inline';
  await rememberOverlays(page);
  await locator.click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
  // A popover can be opened by a plain aria-expanded button, so look for an overlay either way.
  let opened: Locator | null = null;
  await expect
    .poll(
      async () => {
        opened = await newOverlay(page);
        return opened !== null || (disclosure && (await expanded()));
      },
      { timeout: STEP_TIMEOUT_MS },
    )
    .toBe(true)
    .catch(() => undefined);
  if (opened) return opened;
  return disclosure && (await expanded()) ? 'inline' : null;
}

/** From the target, opens each trigger in `path` in turn; returns the innermost container. */
async function reopen(crawl: Crawl, path: readonly ControlRef[]): Promise<Opened | null> {
  const { page } = crawl;
  if (page.url() !== crawl.landed) await gotoTarget(crawl);
  await closeOverlays(page);
  let scope: Locator | undefined;
  let inDialog = false;
  const triggers: ElementHandle[] = [];
  const disclosures: ElementHandle[] = [];
  for (const trigger of path) {
    const locator = locateControl(page, trigger, scope);
    const handle = await locator.elementHandle({ timeout: STEP_TIMEOUT_MS }).catch(() => null);
    if (!handle) return null;
    triggers.push(handle);
    const opened = await openTrigger(page, locator, handle);
    if (opened === null) return null;
    await waitForSettled(page);
    if (opened === 'inline') {
      disclosures.push(handle);
    } else {
      scope = opened;
      inDialog = await isDialog(opened);
    }
  }
  return { scope, triggers, inDialog, disclosures };
}

async function cancelDialog(page: Page, overlay: Locator) {
  const cancel = overlay.getByRole('button', { name: 'Cancel', exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click({ timeout: STEP_TIMEOUT_MS });
  else await page.keyboard.press('Escape');
  await waitForSettled(page);
}

async function isCurrent(handle: ElementHandle<Element>): Promise<boolean> {
  return handle
    .evaluate(
      (el) =>
        el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-selected') === 'true' ||
        (el.getAttribute('aria-current') ?? 'false') !== 'false',
    )
    .catch(() => false);
}

/** Skips a control the crawl must not or need not activate; true when it was skipped. */
function skipped(crawl: Crawl, path: readonly ControlRef[], control: ControlRef): boolean {
  if (SIGN_OUT.test(control.name)) {
    crawl.deferred.push(`${describeControl(control, path)}: covered by the sign-out test`);
    return true;
  }
  if (control.role === 'link' && control.href && /^[a-z]+:/i.test(control.href)) {
    if (new URL(control.href).origin !== WEB_ORIGIN) {
      crawl.external += 1; // checked by checkLinks, never followed
      return true;
    }
  }
  if (control.name === '') {
    record(crawl, control, path, 'has no accessible name');
    return true;
  }
  return false;
}

async function locate(crawl: Crawl, path: readonly ControlRef[], control: ControlRef) {
  const opened = await reopen(crawl, path);
  const handle = opened
    ? await locateControl(crawl.page, control, opened.scope)
        .elementHandle({ timeout: STEP_TIMEOUT_MS })
        .catch(() => null)
    : null;
  return { opened, handle };
}

interface Attempt {
  opened: Opened;
  handle: ElementHandle<Element>;
  effects: Effect[] | null;
  current: boolean;
  before: ControlRef[] | null;
  wrote: boolean;
}

/** Finds `control` (reloading the target once if it is gone) and activates it. */
async function attempt(
  crawl: Crawl,
  path: readonly ControlRef[],
  control: ControlRef,
): Promise<Attempt | string> {
  const { page } = crawl;
  let { opened, handle } = await locate(crawl, path, control);
  if (!opened || !handle) {
    // An earlier control may have left state behind (another tab shown, a list re-sorted): start
    // from a fresh load of the target once before calling it gone.
    await gotoTarget(crawl);
    ({ opened, handle } = await locate(crawl, path, control));
  }
  if (!opened) return 'its container could not be reopened';
  if (!handle) return 'disappeared before it could be activated';
  const current = await isCurrent(handle);
  const before = (await isDisclosure(handle)) ? await collectControls(page, opened.scope) : null;
  flushWatch(crawl, control, path); // anything reopening raised belongs to this control
  await rememberOverlays(page);
  // Every write is blocked outside the throwaway flow: seed data and account settings never
  // change, a newly named outward button is guarded too, and an attempted write still counts as
  // a request. (The setup wizard, the theme and "Restore" used to drift shared state.)
  const writes = await watchWrites(page, true);
  let effects: Effect[] | null = null;
  try {
    effects = await activate(page, control, opened.scope);
  } catch (error) {
    record(crawl, control, path, `could not activate: ${firstLine(error)}`);
  } finally {
    await writes.release();
  }
  return { opened, handle, effects, current, before, wrote: writes.attempts() > 0 };
}

/** Crawls one control, and whatever it opens or reveals. Leaves the page at the target. */
export async function crawlControl(
  crawl: Crawl,
  path: readonly ControlRef[],
  control: ControlRef,
): Promise<void> {
  if (skipped(crawl, path, control)) return;
  let tried = await attempt(crawl, path, control);
  if (typeof tried !== 'string' && tried.effects?.length === 0 && !tried.current) {
    // Before calling it dead, try it once more on a fresh load: an earlier control may have left
    // the state this one would change (an error already shown, a picker already set).
    await collapse(tried.opened.disclosures);
    await gotoTarget(crawl);
    tried = await attempt(crawl, path, control);
  }
  if (typeof tried === 'string') {
    record(crawl, control, path, tried);
    flushWatch(crawl, control, path);
    await restore(crawl);
    return;
  }
  const { opened, handle, effects, current, before, wrote } = tried;
  let inner: ControlRef[] = [];
  if (effects !== null) {
    crawl.activated += 1;
    inner = await judge(crawl, path, control, effects, {
      handle,
      triggers: opened.triggers,
      scope: opened.scope,
      destructive: isDestructive(control.name),
      outward: isOutward(control.name),
      current,
      before,
      wrote,
    });
  }
  await collapse(before === null ? opened.disclosures : [...opened.disclosures, handle]);
  flushWatch(crawl, control, path);
  await restore(crawl);
  flushWatch(crawl, control, path);
  for (const item of inner) await crawlControl(crawl, [...path, control], item);
}

interface JudgeContext {
  handle: ElementHandle;
  triggers: ElementHandle[];
  scope: Locator | undefined;
  destructive: boolean;
  /** Reaches outside the workspace: never let through, never confirmed. */
  outward: boolean;
  /** Already pressed, selected or current: choosing it again may rightly do nothing. */
  current: boolean;
  /** The scope's controls before a disclosure was activated, or null for anything else. */
  before: ControlRef[] | null;
  /** It tried to write to the API (blocked or not). */
  wrote: boolean;
}

/** The controls inside what `control` opened or revealed, and links checked there. */
async function innerControls(
  crawl: Crawl,
  path: readonly ControlRef[],
  control: ControlRef,
  overlay: Locator | null,
  ctx: JudgeContext,
): Promise<ControlRef[]> {
  const { page } = crawl;
  if (overlay) {
    const panel = PANEL_TRIGGERS.has(control.name) || !(await isModal(overlay));
    const modalDialog = !panel && (await isDialog(overlay));
    await checkLinks(crawl, overlay, [...path, control]);
    return (await collectControls(page, overlay)).filter(
      (c) => panel || INNER_ROLES.has(c.role) || (modalDialog && c.role === 'button'),
    );
  }
  if (ctx.before === null) return [];
  // A disclosure: what it revealed is whatever was not there before, except the disclosure
  // itself under its new name ("Hide …").
  const known = new Set(ctx.before.map(controlKey));
  await checkLinks(crawl, ctx.scope ?? page.locator('body'), [...path, control]);
  const revealed: ControlRef[] = [];
  for (const c of await collectControls(page, ctx.scope)) {
    if (known.has(controlKey(c))) continue;
    const itself = await locateControl(page, c, ctx.scope)
      .evaluate((el, trigger) => el === trigger, ctx.handle)
      .catch(() => false);
    if (!itself) revealed.push(c);
  }
  return revealed;
}

/** Records what is wrong with what `control` did; returns the controls to crawl inside it. */
async function judge(
  crawl: Crawl,
  path: readonly ControlRef[],
  control: ControlRef,
  effects: Effect[],
  ctx: JudgeContext,
): Promise<ControlRef[]> {
  const { page } = crawl;
  if (effects.length === 0) {
    if (ctx.current) crawl.currentNoops.push(describeControl(control, path));
    else record(crawl, control, path, DEAD);
    return [];
  }
  if (effects.includes('navigated')) {
    await checkLanding(crawl, control, path);
    return [];
  }
  const overlay =
    effects.includes('dialog') || effects.includes('expanded') ? await newOverlay(page) : null;
  if (ctx.destructive && overlay === null && ctx.wrote) {
    record(crawl, control, path, 'writes without asking for confirmation');
  } else if (ctx.destructive && overlay === null) {
    crawl.noConfirmNeeded.push(describeControl(control, path));
  }

  if (ctx.outward) {
    const what = overlay ? 'its dialog cancelled' : ctx.wrote ? 'its write blocked' : 'no write';
    crawl.outward.push(`${describeControl(control, path)}: ${what}`);
  }
  let inner: ControlRef[] = [];
  if (overlay && (ctx.destructive || ctx.outward)) {
    await cancelDialog(page, overlay);
    if (ctx.destructive) crawl.destructiveCancelled += 1;
  } else if (path.length < MAX_DEPTH && (overlay || effects.includes('expanded'))) {
    inner = await innerControls(crawl, path, control, overlay, ctx);
  }

  const closes = overlay !== null || path.length > 0 || effects.includes('expanded');
  if (closes) {
    await closeOverlays(page);
    if (!(await focusReturned([ctx.handle, ...[...ctx.triggers].reverse()]))) {
      record(
        crawl,
        control,
        path,
        'focus did not return to the trigger when its dialog or menu closed',
      );
    }
  }
  return inner;
}

interface Planned {
  path: ControlRef[];
  control: ControlRef;
}

/** Every destructive control on a contact page, including those inside menus and panels. */
async function discoverDestructive(crawl: Crawl, path: ControlRef[]): Promise<Planned[]> {
  const opened = await reopen(crawl, path);
  if (!opened) return [];
  const controls = await collectControls(crawl.page, opened.scope);
  const plan: Planned[] = [];
  const explore: ControlRef[] = [];
  for (const control of controls) {
    if (SIGN_OUT.test(control.name)) continue;
    if (isDestructive(control.name)) plan.push({ path, control });
    else if (
      path.length < MAX_DEPTH &&
      (await isPopupTrigger(locateControl(crawl.page, control, opened.scope), control).catch(
        () => false,
      ))
    ) {
      explore.push(control);
    }
  }
  await closeOverlays(crawl.page);
  for (const trigger of explore) {
    plan.push(...(await discoverDestructive(crawl, [...path, trigger])));
  }
  return plan;
}

/** Clicks the confirmation's confirm button; true when one was clicked. */
async function confirmDialog(
  crawl: Crawl,
  path: readonly ControlRef[],
  control: ControlRef,
  overlay: Locator,
): Promise<boolean> {
  const buttons = (await collectControls(crawl.page, overlay)).filter(
    (c) => c.role === 'button' && !/^(cancel|close)\b/i.test(c.name),
  );
  const confirm = buttons.find((c) => isDestructive(c.name)) ?? buttons.at(-1);
  if (!confirm) {
    record(crawl, control, path, 'its confirmation has no confirm button');
    return false;
  }
  const effects = await activate(crawl.page, confirm, overlay);
  if (!effects.includes('request')) {
    record(crawl, control, path, `confirming with "${confirm.name}" sent nothing to the server`);
  }
  return true;
}

/** A fresh throwaway with `path` reopened; null (recorded) when the container would not open. */
async function freshThrowaway(crawl: Crawl, { path, control }: Planned, label: string) {
  crawl.url = `/contacts/${await createThrowaway(crawl.page.request, label)}`;
  await gotoTarget(crawl);
  flushWatch(crawl, control, path);
  const opened = await reopen(crawl, path);
  if (!opened) record(crawl, control, path, 'its container could not be reopened');
  return opened;
}

/**
 * One planned destructive control, on its own fresh throwaway contact, confirmed for real. A
 * control with no effect gets one more try on another fresh throwaway before it is called dead.
 */
async function destroyOnce(crawl: Crawl, planned: Planned, label: string) {
  const { page } = crawl;
  const { path, control } = planned;
  try {
    let opened = await freshThrowaway(crawl, planned, label);
    if (!opened) return;
    await rememberOverlays(page);
    let writes = await watchWrites(page, false);
    let effects = await activate(page, control, opened.scope);
    await writes.release();
    if (effects.length === 0) {
      opened = await freshThrowaway(crawl, planned, `${label} retry`);
      if (!opened) return;
      await rememberOverlays(page);
      writes = await watchWrites(page, false);
      effects = await activate(page, control, opened.scope);
      await writes.release();
    }
    crawl.activated += 1;
    const dialog = effects.length > 0 ? await newOverlay(page) : null;
    if (effects.length === 0) {
      record(crawl, control, path, DEAD);
    } else if (dialog) {
      if (await confirmDialog(crawl, path, control, dialog)) {
        crawl.confirmedNames.push(describeControl(control, path));
      }
    } else if (writes.attempts() > 0) {
      record(crawl, control, path, 'writes without asking for confirmation');
    } else {
      crawl.noConfirmNeeded.push(describeControl(control, path));
    }
  } catch (error) {
    record(crawl, control, path, `could not activate: ${firstLine(error)}`);
  }
  await checkLanding(crawl, control, path);
  flushWatch(crawl, control, path);
}

/** Destructive controls, each on a fresh throwaway contact, confirmed for real. */
export async function crawlThrowaway(crawl: Crawl) {
  const { page } = crawl;
  crawl.url = `/contacts/${await createThrowaway(page.request, `${crawl.viewport} discovery`)}`;
  await gotoTarget(crawl);
  await waitForLoaded(page);
  const plan = await discoverDestructive(crawl, []);
  flushWatch(crawl, null, []);
  if (plan.length === 0) record(crawl, null, [], 'found no destructive control to exercise');
  for (const [index, planned] of plan.entries()) {
    await destroyOnce(crawl, planned, `${crawl.viewport} ${index + 1}`);
  }
}

/** The whole page: load checks, then every control on it. */
export async function crawlPage(crawl: Crawl, mustExplain: boolean) {
  const { page } = crawl;
  await gotoTarget(crawl);
  await waitForLoaded(page);
  await waitForSettled(page);
  await checkLanding(crawl, null, []);
  await checkLinks(crawl, page.locator('body'), []);
  if (mustExplain) {
    const explained = await page.getByRole('heading', { level: 1 }).first().isVisible();
    if (!explained) record(crawl, null, [], 'shows no heading explaining the signed-out state');
  }
  flushWatch(crawl, null, []);
  for (const control of await collectControls(page)) await crawlControl(crawl, [], control);
}

export function annotations(crawl: Crawl): { type: string; description: string }[] {
  const notes = [
    {
      type: 'controls',
      description: `${crawl.activated} activated, ${crawl.external} external links checked`,
    },
    {
      type: 'destructive',
      description: `${crawl.confirmedNames.length} confirmed on throwaways, ${crawl.destructiveCancelled} cancelled`,
    },
  ];
  const add = (type: string, lines: readonly string[]) => {
    for (const description of lines) notes.push({ type, description });
  };
  add('destructive confirmed', crawl.confirmedNames);
  add('destructive name, no confirmation needed (no write)', crawl.noConfirmNeeded);
  add('outward, never let through', crawl.outward);
  for (const [path, keys] of noiseMasks(crawl.page)) {
    for (const key of keys) notes.push({ type: 'noise mask', description: `${path}: ${key}` });
  }
  for (const [path, keys] of refusedNoise(crawl.page)) {
    for (const key of keys) {
      notes.push({ type: 'noise left unmasked (holds controls)', description: `${path}: ${key}` });
    }
  }
  add('deferred', crawl.deferred);
  add('already current, no-op allowed', crawl.currentNoops);
  add('known, routed', crawl.known);
  return notes;
}

import type { Locator, Page, Request } from '@playwright/test';
import {
  type ControlRef,
  diffEffects,
  type Effect,
  type EffectSnapshot,
  type NoiseEntry,
  noisyKeys,
  parseControls,
  promoteNoise,
} from './controls';

/**
 * The page side of the dead-control crawler: the in-page probe (meaningful mutations, focus,
 * clipboard), settling and noise masks, and activating one control. The pure rules it applies
 * live in controls.ts.
 */

/** The settle bound (controller ruling); a page still churning then gets a noise mask. */
const SETTLE_TIMEOUT_MS = 3_000;
/** A subtree counts as noise when it was still mutating in this last stretch of the window. */
const NOISE_RECENT_MS = 1_000;
const SETTLE_QUIET_MS = 250;
const SETTLE_POLL_MS = 50;
const EFFECT_WINDOW_MS = 400;
const PREFOCUS_MS = 60;
const ACTIVATE_TIMEOUT_MS = 4_000;
/** How long a target's first content may take to replace its Skeletons before controls are read. */
const LOADED_TIMEOUT_MS = 20_000;
/** Right before a click the DOM must have held still this long (bounded by QUIET_TIMEOUT_MS). */
const QUIET_BEFORE_CLICK_MS = 300;
const QUIET_TIMEOUT_MS = 2_000;
/** Toasts live 3.6 s; a little more covers one that just appeared. */
const TOAST_TIMEOUT_MS = 4_500;

/** Request types that count as an effect and keep the page busy. */
const TRACKED_TYPES = new Set(['fetch', 'xhr', 'document']);
/** Polling the page does on its own; never the effect of a click. */
const BACKGROUND = [/\/api\/v1\/notifications(\?|$)/];

interface ProbeState {
  /** Noise masks by pathname: selectors whose subtrees churn on their own. Cleared per load. */
  masks: Map<string, Set<string>>;
  /** Every mask ever learned on this page, by pathname, for the report. */
  maskHistory: Map<string, Set<string>>;
  /** Per pathname, how many timed-out settle windows each key churned through. */
  noiseHits: Map<string, Map<string, number>>;
  /** Per pathname, noisy subtrees left unmasked because they hold controls. */
  refused: Map<string, Set<string>>;
  inflight: Set<Request>;
  requests: number;
  downloads: number;
  popups: number;
  nativeDialogs: number;
}

const probes = new WeakMap<Page, ProbeState>();

interface InPageCounters {
  mutations: number;
  focus: number;
  clipboard: number;
  /** The last few counted mutations, for KNOQRA_CRAWL_DEBUG. */
  recent: string[];
  /** One selector list: mutations inside it are noise and never counted. */
  mask: string;
  /** While collecting (a settle window), counted mutations by their stable ancestor's key. */
  collecting: boolean;
  windowStart: number;
  noise: Record<string, NoiseEntry>;
}

/**
 * Runs in the page before its own scripts. Counts meaningful DOM mutations, focus moves and
 * clipboard writes on `window.__kq`.
 *
 * "Meaningful" leaves out what every menu or dialog does as it opens and closes (Radix focus
 * guards, popper wrappers, overlays leaving, and attributes such as aria-expanded, data-state,
 * aria-hidden), `style` changes, and anything inside an `[aria-hidden="true"]` subtree (the
 * ascii-reveal glyph layers). Without that, every menu item would look alive just because the
 * menu closed. Focus returning to a menu or popup trigger is plumbing for the same reason.
 */
function probeScript(): void {
  const w = window as unknown as { __kq?: InPageCounters };
  if (w.__kq) return;
  const kq: InPageCounters = {
    mutations: 0,
    focus: 0,
    clipboard: 0,
    recent: [],
    mask: '',
    collecting: false,
    windowStart: 0,
    noise: {},
  };
  w.__kq = kq;

  const plumbingAttrs = new Set([
    'style',
    'aria-expanded',
    'aria-hidden',
    'aria-controls',
    'aria-describedby',
    'aria-activedescendant',
    'aria-selected',
    'data-state',
    'data-aria-hidden',
    'data-highlighted',
    'data-selected',
    'data-side',
    'data-align',
    'data-orientation',
    'tabindex',
    // ascii-reveal's animation bookkeeping on real content while it decodes in.
    'data-ar-t',
    'data-ar-m',
    'data-ar-tc',
    'data-ar-s',
    'data-ar-f',
    'data-ar-pending',
  ]);
  const overlay =
    '[data-radix-focus-guard],[data-radix-popper-content-wrapper],[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"],[data-state="closed"],[aria-hidden="true"]';
  const elementOf = (node: Node): Element | null =>
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const inHidden = (node: Node) => elementOf(node)?.closest('[aria-hidden="true"]') != null;
  /** A selector for `start`: from its nearest ancestor with an id (or body) down, by nth-of-type. */
  const keyOf = (start: Element): string => {
    const parts: string[] = [];
    for (let el: Element | null = start; el; el = el.parentElement) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') {
        parts.unshift(tag);
        break;
      }
      if (el.id) {
        parts.unshift(`#${CSS.escape(el.id)}`);
        break;
      }
      const self: Element = el;
      const twins = self.parentElement
        ? [...self.parentElement.children].filter((c) => c.tagName === self.tagName)
        : [];
      parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(self) + 1})` : tag);
    }
    return parts.join(' > ');
  };
  // A masked subtree that has since grown a control (a section that was still a Skeleton when it
  // was masked) is not noise any more: its mutations count again.
  const controls =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]';
  const masked = (el: Element): boolean => {
    const root = el.closest(kq.mask);
    return root !== null && !root.matches(controls) && root.querySelector(controls) === null;
  };
  const isPlumbing = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).matches(overlay);
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').trim() === '';
    return true; // comments
  };

  new MutationObserver((records) => {
    for (const record of records) {
      if (inHidden(record.target)) continue;
      if (record.type === 'attributes' && plumbingAttrs.has(record.attributeName ?? '')) continue;
      if (record.type === 'childList') {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.length > 0 && nodes.every(isPlumbing)) continue;
      }
      const el = elementOf(record.target);
      // A node already out of the document cannot be a visible effect: ascii-reveal sizes the
      // offscreen canvases of its decode overlay on every frame of a reveal (R4).
      if (el && !el.isConnected) continue;
      if (kq.mask && el && masked(el)) continue;
      kq.mutations += 1;
      const key = el ? keyOf(el) : '?';
      if (kq.collecting) {
        const entry = kq.noise[key] ?? { count: 0, last: 0 };
        kq.noise[key] = { count: entry.count + 1, last: performance.now() - kq.windowStart };
      }
      kq.recent = [...kq.recent.slice(-4), `${record.type}:${record.attributeName ?? ''}@${key}`];
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });

  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (!(el instanceof Element)) return;
      if (el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded')) return;
      kq.focus += 1;
    },
    true,
  );

  const clipboard = navigator.clipboard;
  if (clipboard) {
    const writeText = clipboard.writeText?.bind(clipboard);
    const write = clipboard.write?.bind(clipboard);
    if (writeText) {
      clipboard.writeText = (text: string) => {
        kq.clipboard += 1;
        return writeText(text);
      };
    }
    if (write) {
      clipboard.write = (items: ClipboardItems) => {
        kq.clipboard += 1;
        return write(items);
      };
    }
  }
}

/**
 * Call before the first navigation. Adds the in-page probe, counts requests, downloads, popups and
 * native dialogs, and dismisses every native `confirm()`/`alert()` (nothing is ever confirmed).
 */
export async function installProbe(page: Page): Promise<void> {
  if (probes.has(page)) return;
  const state: ProbeState = {
    masks: new Map(),
    maskHistory: new Map(),
    noiseHits: new Map(),
    refused: new Map(),
    inflight: new Set(),
    requests: 0,
    downloads: 0,
    popups: 0,
    nativeDialogs: 0,
  };
  probes.set(page, state);
  // Microphone granted up front: otherwise the first control that asks for it (the setup wizard's
  // audio step) is auto-denied by headless Chromium, the browser remembers the denial, and the
  // Numbers checks swap "Continue" for "How to allow" under the crawler's feet.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write', 'microphone']);
  await page.addInitScript(probeScript);
  const done = (request: Request) => state.inflight.delete(request);
  page.on('request', (request) => {
    if (!TRACKED_TYPES.has(request.resourceType())) return;
    state.inflight.add(request);
    if (!BACKGROUND.some((re) => re.test(request.url()))) state.requests += 1;
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('download', () => {
    state.downloads += 1;
  });
  page.on('popup', (popup) => {
    state.popups += 1;
    void popup.close().catch(() => undefined);
  });
  page.on('dialog', (dialog) => {
    state.nativeDialogs += 1;
    void dialog.dismiss().catch(() => undefined);
  });
  // With a listener attached, Playwright keeps the native picker closed; opening it is the effect.
  page.on('filechooser', () => {
    state.nativeDialogs += 1;
  });
}

/** Whether a Skeleton (or any status) still says it is loading, and the mutation count now. */
function settleSample(): { loading: boolean; mutations: number; recent: string[] } {
  const loading = [...document.querySelectorAll('[role="status"]')].some((el) => {
    const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
    return /^(Loading|Checking)/.test(label.trim());
  });
  const kq = (window as unknown as { __kq?: InPageCounters }).__kq;
  return { loading, mutations: kq?.mutations ?? 0, recent: kq?.recent ?? [] };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Starts a settle window in the page: applies the known mask, starts collecting noise keys. */
function openWindow(mask: string): void {
  const kq = (window as unknown as { __kq?: InPageCounters }).__kq;
  if (!kq) return;
  kq.mask = mask;
  kq.noise = {};
  kq.windowStart = performance.now();
  kq.collecting = true;
}

/** Ends the settle window; returns what churned, by key. */
function closeWindow(): Record<string, NoiseEntry> {
  const kq = (window as unknown as { __kq?: InPageCounters }).__kq;
  if (!kq) return {};
  kq.collecting = false;
  return kq.noise;
}

function setMask(mask: string): void {
  const kq = (window as unknown as { __kq?: InPageCounters }).__kq;
  if (kq) kq.mask = mask;
}

function maskSelector(masks: ReadonlySet<string> | undefined): string {
  return masks ? [...masks].join(', ') : '';
}

/**
 * Settled means: no status says "Loading…"/"Checking…", no fetch, XHR or document request is in
 * flight, and the DOM has been quiet (no counted mutation) for 250 ms. Bounded at 3 s. When the
 * bound is hit, the subtrees still mutating near its end become this page's noise mask (see
 * `noiseMasks`): mutations inside them are left out of every later effect diff on the page. A page
 * that never settles is still crawled, and its controls are judged on what they do.
 */
export async function waitForSettled(page: Page, timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
  const state = probes.get(page);
  const path = pathOf(page.url());
  await page.evaluate(openWindow, maskSelector(state?.masks.get(path))).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  let quietSince: number | null = null;
  let lastMutations = -1;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(settleSample).catch(() => null);
    const churned = sample !== null && sample.mutations !== lastMutations;
    lastMutations = sample?.mutations ?? -1;
    const busy = sample === null || sample.loading || churned || (state?.inflight.size ?? 0) > 0;
    const now = Date.now();
    if (busy) quietSince = null;
    else if (quietSince === null) quietSince = now;
    else if (now - quietSince >= SETTLE_QUIET_MS) {
      await page.evaluate(closeWindow).catch(() => undefined);
      return;
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  const noise = await page.evaluate(closeWindow).catch(() => ({}));
  const keys = noisyKeys(noise, timeoutMs, NOISE_RECENT_MS);
  if (state && keys.length > 0) await learnNoise(page, state, path, keys);
  if (process.env.KNOQRA_CRAWL_DEBUG) {
    const sample = await page.evaluate(settleSample).catch(() => 'unknown');
    const inflight = [...(state?.inflight ?? [])].map((r) => `${r.method()} ${r.url()}`);
    process.stderr.write(
      `[crawl] not settled after ${timeoutMs} ms at ${page.url()}: ${JSON.stringify(sample)} inflight=${JSON.stringify(inflight)} masked=${JSON.stringify(keys)} noise=${JSON.stringify(noise)}\n`,
    );
  }
}

/**
 * Waits (up to `timeoutMs`) until no status says "Loading…"/"Checking…". The 3 s settle bound is
 * right between clicks, but under load a page's first content can take longer, and collecting its
 * controls before then would crawl only the shell. A page that shows a Skeleton for good (the
 * showcase) just costs the full wait once.
 */
export async function waitForLoaded(page: Page, timeoutMs = LOADED_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(settleSample).catch(() => null);
    if (sample !== null && !sample.loading) return;
    await page.waitForTimeout(SETTLE_POLL_MS * 4);
  }
}

/** Interactive elements: a subtree holding one is never masked, or its effects would vanish. */
const CONTROLS =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]';

/** Keys whose subtree holds a control (or is one). */
function holdingControls([keys, controls]: [string[], string]): string[] {
  return keys.filter((key) => {
    try {
      const el = document.querySelector(key);
      return el !== null && (el.matches(controls) || el.querySelector(controls) !== null);
    } catch {
      return true; // not a valid selector here: leave it unmasked
    }
  });
}

/**
 * Masks keys that churned through two timed-out windows, unless their subtree holds a control:
 * those are refused (and listed), so a control's own effect can never be hidden.
 */
async function learnNoise(page: Page, state: ProbeState, path: string, keys: string[]) {
  const { hits, promoted } = promoteNoise(state.noiseHits.get(path) ?? new Map(), keys);
  state.noiseHits.set(path, hits);
  if (promoted.length === 0) return;
  const unsafe = new Set(
    await page
      .evaluate(holdingControls, [promoted, CONTROLS] as [string[], string])
      .catch(() => promoted),
  );
  const masks = state.masks.get(path) ?? new Set<string>();
  const refused = state.refused.get(path) ?? new Set<string>();
  for (const key of promoted) (unsafe.has(key) ? refused : masks).add(key);
  state.masks.set(path, masks);
  const history = state.maskHistory.get(path) ?? new Set<string>();
  for (const key of masks) history.add(key);
  state.maskHistory.set(path, history);
  state.refused.set(path, refused);
  await page.evaluate(setMask, maskSelector(masks)).catch(() => undefined);
}

/** Noisy subtrees left unmasked because they hold controls, by pathname. */
export function refusedNoise(page: Page): Map<string, string[]> {
  const refused = probes.get(page)?.refused ?? new Map<string, Set<string>>();
  return new Map([...refused].map(([path, keys]) => [path, [...keys]]));
}

/** Every noise mask learned on this page so far (including forgotten ones), by pathname. */
export function noiseMasks(page: Page): Map<string, string[]> {
  const masks = probes.get(page)?.maskHistory ?? new Map<string, Set<string>>();
  return new Map([...masks].map(([path, keys]) => [path, [...keys]]));
}

/**
 * Forgets the masks (and the churn counts behind them) learned so far. Mask selectors are
 * positional, so after a fresh load they are learned again rather than trusted: a stale one could
 * cover a control that now sits where the noise was.
 */
export function forgetNoise(page: Page): void {
  const state = probes.get(page);
  if (!state) return;
  state.masks.clear();
  state.noiseHits.clear();
}

function mutationCount(): number {
  return (window as unknown as { __kq?: InPageCounters }).__kq?.mutations ?? 0;
}

/**
 * Waits for the counted-mutation total to hold still for `quietMs`, at most `timeoutMs`. Unlike
 * waitForSettled it ignores loading statuses and requests: a page may show a Skeleton for good
 * (the showcase does), and still be quiet enough to judge a click.
 */
export async function waitForQuiet(
  page: Page,
  quietMs = QUIET_BEFORE_CLICK_MS,
  timeoutMs = QUIET_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let since = Date.now();
  while (Date.now() < deadline) {
    const now = await page.evaluate(mutationCount).catch(() => -1);
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
}

/** True while a toast (a fixed-position status with text) is still on screen. */
function toastShowing(): boolean {
  return [...document.querySelectorAll('[role="status"]')].some((el) => {
    if ((el.textContent ?? '').trim() === '') return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (getComputedStyle(node).position === 'fixed') return true;
    }
    return false;
  });
}

/** Waits (up to `timeoutMs`) for every toast to leave, so its exit is not the next control's effect. */
export async function waitForToasts(page: Page, timeoutMs = TOAST_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (await page.evaluate(toastShowing).catch(() => false))) {
    await page.waitForTimeout(SETTLE_POLL_MS * 2);
  }
}

type InPageSnapshot = Pick<
  EffectSnapshot,
  'url' | 'mutations' | 'fields' | 'focus' | 'clipboard' | 'dialogs' | 'expanded'
>;

function readPage(): InPageSnapshot {
  const kq = (window as unknown as { __kq?: InPageCounters }).__kq;
  const shown = (el: Element) =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  return {
    url: location.href,
    mutations: kq?.mutations ?? 0,
    fields: [...document.querySelectorAll('input, textarea, select')]
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .map((el) => {
        const field = el as HTMLInputElement;
        return field.type === 'checkbox' || field.type === 'radio'
          ? String(field.checked)
          : field.value;
      })
      .join('\u0001'),
    focus: kq?.focus ?? 0,
    clipboard: kq?.clipboard ?? 0,
    dialogs: [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(shown)
      .length,
    expanded: [...document.querySelectorAll('[aria-expanded="true"]')].filter(shown).length,
  };
}

export async function snapshotEffects(page: Page): Promise<EffectSnapshot> {
  const state = probes.get(page);
  let inPage: InPageSnapshot | undefined;
  for (let attempt = 0; attempt < 3 && inPage === undefined; attempt += 1) {
    try {
      inPage = await page.evaluate(readPage);
    } catch {
      // The context was replaced by a navigation; wait for the new document.
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }
  }
  const counters: InPageSnapshot = inPage ?? {
    url: page.url(),
    mutations: 0,
    fields: '',
    focus: 0,
    clipboard: 0,
    dialogs: 0,
    expanded: 0,
  };
  return {
    ...counters,
    dialogs: counters.dialogs + (state?.nativeDialogs ?? 0),
    requests: state?.requests ?? 0,
    downloads: state?.downloads ?? 0,
    popups: state?.popups ?? 0,
  };
}

/** Visible, enabled (not disabled, not aria-disabled) controls in `scope`, or the whole page. */
export async function collectControls(page: Page, scope?: Locator): Promise<ControlRef[]> {
  const root = scope ?? page.locator('body');
  return parseControls(await root.ariaSnapshot({ timeout: ACTIVATE_TIMEOUT_MS }));
}

export function locateControl(page: Page, control: ControlRef, scope?: Locator): Locator {
  return (scope ?? page.locator('body'))
    .getByRole(control.role, { name: control.name, exact: true })
    .nth(control.nth);
}

/**
 * Activates `control` and returns what it did; `[]` means dead. The control is focused first, so
 * the click's own focus move is not mistaken for an effect. Menu items are chosen with Enter, as
 * a keyboard user would; everything else is clicked. Throws when the control cannot be reached
 * (covered, detached, never actionable).
 */
export async function activate(
  page: Page,
  control: ControlRef,
  scope?: Locator,
): Promise<Effect[]> {
  const target = locateControl(page, control, scope);
  await target.focus({ timeout: ACTIVATE_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForTimeout(PREFOCUS_MS);
  // Click into a still DOM: churn still running from a load would be credited to the control.
  await waitForQuiet(page);
  const before = await snapshotEffects(page);
  const focused =
    control.role === 'menuitem' &&
    (await target.evaluate((el) => el === document.activeElement).catch(() => false));
  // A visually hidden file input is clicked where it sits, which is its label, as a user would.
  const fileInput = await target
    .evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')
    .catch(() => false);
  if (focused) await page.keyboard.press('Enter');
  else await target.click({ timeout: ACTIVATE_TIMEOUT_MS, force: fileInput });
  await page.waitForTimeout(EFFECT_WINDOW_MS);
  await waitForSettled(page);
  return diffEffects(before, await snapshotEffects(page));
}

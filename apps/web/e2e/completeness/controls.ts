import { matchesKnownRoute, type RoutePattern, type RouteTarget } from './routes';

/**
 * The dead-control crawler's toolkit: find every control on a screen, activate one, and say what
 * it did. A control that did nothing at all (no navigation, request, DOM change, focus move,
 * dialog, expansion, download, popup or clipboard write) is dead.
 *
 * This file holds the pure parts (DESTRUCTIVE, parseControls, diffEffects, linkProblem, noise
 * selection, ...), unit tested in controls.test.ts. The page parts (the in-page probe, settling,
 * activation) live in probe.ts and are exercised by crawl.spec.ts.
 */

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

/**
 * Controls whose name says they destroy, end or block something. Confirmed only on throwaway
 * contacts. The consent actions count too: "Do not contact" blocks every channel and "Opted out"
 * records a refusal, so seeded contacts must never get them.
 */
export const DESTRUCTIVE: RegExp =
  /\b(delete|archive|merge|remove|revoke|sign out|turn off|disable|reset|dismiss|not the same|stop and leave|do not contact|opt(?:ed)?[- ]out)\b/i;

export function isDestructive(name: string): boolean {
  return DESTRUCTIVE.test(name);
}

/**
 * Controls that reach outside the workspace: send a message, place a call, buy or release a
 * number, connect or disconnect a provider. The crawl never lets one through: it runs with every
 * write blocked and any dialog it opens is cancelled. Unlike DESTRUCTIVE, acting without a
 * confirmation is expected (Send sends).
 */
export const OUTWARD: RegExp =
  /^(send|buy|purchase|call|connect|release|add credit|top up)\b|\b(send message|send now|buy number|release number|reconnect|disconnect|call back|place call|start call|test call|hang up|save connection)\b/i;

export function isOutward(name: string): boolean {
  return OUTWARD.test(name);
}

export interface NoiseEntry {
  count: number;
  /** ms since the settle window opened, of the last mutation in this subtree. */
  last: number;
}

/**
 * Counts how many timed-out settle windows each key churned through; returns the new counts and
 * the keys that have now churned through `needed` windows. Loading churns once per load; real
 * noise (a ticking clock) keeps coming back.
 */
export function promoteNoise(
  hits: ReadonlyMap<string, number>,
  keys: readonly string[],
  needed = 2,
): { hits: Map<string, number>; promoted: string[] } {
  const next = new Map(hits);
  const promoted: string[] = [];
  for (const key of keys) {
    const count = (next.get(key) ?? 0) + 1;
    next.set(key, count);
    if (count === needed) promoted.push(key);
  }
  return { hits: next, promoted };
}

/** Never masked: masking them would hide every effect on the page. */
const UNMASKABLE = new Set(['html', 'body', '#root', '#main']);

/**
 * The subtrees that kept mutating to the end of a settle window that ran out (`windowMs`): those
 * whose last mutation came within `recentMs` of the end. They become the page's noise mask.
 */
export function noisyKeys(
  noise: Readonly<Record<string, NoiseEntry>>,
  windowMs: number,
  recentMs: number,
): string[] {
  return Object.entries(noise)
    .filter(([key, entry]) => !UNMASKABLE.has(key) && entry.last >= windowMs - recentMs)
    .map(([key]) => key)
    .sort();
}

/**
 * `option` extends the brief's four roles: the command palette (cmdk) lists its destinations as
 * listbox options, and the controller asked for its items to be activated too.
 */
export type ControlRole = 'button' | 'link' | 'menuitem' | 'tab' | 'option';
export const CONTROL_ROLES: readonly ControlRole[] = [
  'button',
  'link',
  'menuitem',
  'tab',
  'option',
];

export interface ControlRef {
  role: ControlRole;
  /** The accessible name, exactly as `getByRole(role, { name, exact: true })` matches it. */
  name: string;
  /** Index among every element with this role and name, disabled ones included. */
  nth: number;
  href?: string;
}

export type Effect =
  | 'navigated'
  | 'request'
  | 'dom'
  | 'focus'
  | 'dialog'
  | 'expanded'
  | 'download'
  | 'popup'
  | 'clipboard';

/** `button "Save"`, or `button "Revoke" #2` for the second of several. */
export function controlKey(control: ControlRef): string {
  const base = `${control.role} "${control.name}"`;
  return control.nth > 0 ? `${base} #${control.nth + 1}` : base;
}

interface SnapshotEntry {
  indent: number;
  role: string;
  name: string;
  attrs: string[];
}

/** Reads one YAML-quoted scalar at the start of `text`; returns it and what follows. */
function readQuoted(text: string): { value: string; rest: string } | null {
  const quote = text[0];
  if (quote === "'") {
    let value = '';
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === "'" && text[i + 1] === "'") {
        value += "'";
        i += 1;
      } else if (text[i] === "'") {
        return { value, rest: text.slice(i + 1) };
      } else {
        value += text[i];
      }
    }
    return null;
  }
  if (quote === '"') {
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === '\\') {
        i += 1;
      } else if (text[i] === '"') {
        return { value: JSON.parse(text.slice(0, i + 1)) as string, rest: text.slice(i + 1) };
      }
    }
    return null;
  }
  return null;
}

/** `role "name" [attr] [attr=x]`, the key of one aria snapshot line. */
function parseEntry(key: string, indent: number): SnapshotEntry | null {
  const role = /^[a-z]+/.exec(key)?.[0];
  if (!role) return null;
  let rest = key.slice(role.length);
  let name = '';
  if (rest.startsWith(' "')) {
    const quoted = readQuoted(rest.slice(1));
    if (!quoted) return null;
    name = quoted.value;
    rest = quoted.rest;
  }
  const attrs = [...rest.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] as string);
  return { indent, role, name, attrs };
}

function unquoteScalar(raw: string): string {
  const value = raw.trim();
  return readQuoted(value)?.value ?? value;
}

/**
 * The enabled controls in a Playwright aria snapshot (`locator.ariaSnapshot()`), in document
 * order. The snapshot already leaves out hidden and aria-hidden elements; `[disabled]` covers
 * both `disabled` and `aria-disabled="true"`.
 */
export function parseControls(snapshot: string): ControlRef[] {
  const seen = new Map<string, number>();
  const found: { ref: ControlRef; indent: number; skip: boolean }[] = [];
  // Ancestors of the current line, to tell a native <select>'s options from a listbox's.
  let ancestors: { indent: number; role: string }[] = [];
  for (const line of snapshot.split('\n')) {
    const match = /^(\s*)- (.*)$/.exec(line);
    if (!match) continue;
    const indent = (match[1] as string).length;
    let body = (match[2] as string).trimEnd();
    const last = found.at(-1);
    if (body.startsWith('/url:')) {
      if (last && last.ref.role === 'link' && indent > last.indent) {
        last.ref.href = unquoteScalar(body.slice('/url:'.length));
      }
      continue;
    }
    if (body.startsWith("'") || body.startsWith('"')) {
      const quoted = readQuoted(body);
      if (!quoted) continue;
      body = quoted.value;
    } else if (body.endsWith(':')) {
      body = body.slice(0, -1);
    }
    const entry = parseEntry(body, indent);
    if (!entry) continue;
    ancestors = ancestors.filter((a) => a.indent < indent);
    const parent = ancestors.at(-1);
    ancestors.push({ indent, role: entry.role });
    if (!CONTROL_ROLES.includes(entry.role as ControlRole)) continue;
    const role = entry.role as ControlRole;
    const key = `${role}\u0000${entry.name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    found.push({
      ref: { role, name: entry.name, nth },
      indent,
      // A native <select> is a form field, not a list of controls.
      skip: entry.attrs.includes('disabled') || (role === 'option' && parent?.role === 'combobox'),
    });
  }
  return found.filter((f) => !f.skip).map((f) => f.ref);
}

export interface EffectSnapshot {
  url: string;
  /** Meaningful DOM mutations (see the probe). Reset by a full page load. */
  mutations: number;
  /**
   * The values of the page's form fields, joined. A React-controlled value (a keypad digit typed
   * into the dialer) changes the property, not the DOM, so the mutation count misses it.
   */
  fields: string;
  /** Focus moves to anything other than a menu or popup trigger. */
  focus: number;
  clipboard: number;
  requests: number;
  /** Open dialogs, native `confirm()` and `alert()` included. */
  dialogs: number;
  expanded: number;
  downloads: number;
  popups: number;
}

const EFFECT_ORDER: readonly Effect[] = [
  'navigated',
  'request',
  'dom',
  'focus',
  'dialog',
  'expanded',
  'download',
  'popup',
  'clipboard',
];

/** What changed between two snapshots. `[]` means the control is dead. */
export function diffEffects(before: EffectSnapshot, after: EffectSnapshot): Effect[] {
  const moved: Record<Effect, boolean> = {
    navigated: before.url !== after.url,
    request: after.requests > before.requests,
    // In-page counters reset on a full load, so any difference counts, not only growth.
    dom: after.mutations !== before.mutations || after.fields !== before.fields,
    focus: after.focus !== before.focus,
    dialog: after.dialogs !== before.dialogs,
    expanded: after.expanded !== before.expanded,
    download: after.downloads > before.downloads,
    popup: after.popups > before.popups,
    clipboard: after.clipboard !== before.clipboard,
  };
  return EFFECT_ORDER.filter((effect) => moved[effect]);
}

export interface LinkInfo {
  /** Absolute URL, or the raw attribute when it is empty or a `javascript:` URL. */
  href: string;
  target: string | null;
  rel: string | null;
}

/** Why a link is wrong, or null when it is fine. */
export function linkProblem(
  link: LinkInfo,
  origin: string,
  patterns: readonly RoutePattern[],
): string | null {
  const raw = link.href.trim();
  if (raw === '') return 'link has an empty href';
  if (/^javascript:/i.test(raw)) return 'link uses a javascript: URL';
  const url = new URL(raw, origin);
  if (['mailto:', 'tel:', 'sms:'].includes(url.protocol)) return null;
  if (url.origin === origin) {
    // API downloads (exports) are served by the Worker, not the router.
    if (url.pathname.startsWith('/api/')) return null;
    return matchesKnownRoute(url.pathname, [...patterns])
      ? null
      : `links to unknown route ${url.pathname}`;
  }
  const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
  if (link.target === '_blank' && !rel.includes('noopener')) {
    return `opens ${raw} in a new tab without rel="noopener"`;
  }
  return null;
}

/** `[route @ viewport] <role> "<name>" (in <trigger> › <trigger>): <problem>` */
export function formatProblem(
  target: string,
  viewport: string,
  control: ControlRef | null,
  path: readonly ControlRef[],
  problem: string,
): string {
  return `[${target} @ ${viewport}] ${describeControl(control, path)}: ${problem}`;
}

export function describeControl(control: ControlRef | null, path: readonly ControlRef[]): string {
  const where = path.length > 0 ? ` (in ${path.map(controlKey).join(' › ')})` : '';
  return `${control ? controlKey(control) : 'page'}${where}`;
}

/**
 * Narrows the crawl to `KNOQRA_CRAWL_ROUTES`: comma-separated patterns (`/contacts/$contactId`,
 * every variant) or labels (`/contacts/$contactId (full)`). Empty means every target.
 */
export function filterTargets(targets: RouteTarget[], filter: string | undefined): RouteTarget[] {
  const tokens = (filter ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return targets;
  const hits = (token: string, t: RouteTarget) => t.pattern === token || t.label === token;
  for (const token of tokens) {
    if (!targets.some((t) => hits(token, t))) {
      throw new Error(`KNOQRA_CRAWL_ROUTES: "${token}" matches no route target`);
    }
  }
  return targets.filter((t) => tokens.some((token) => hits(token, t)));
}

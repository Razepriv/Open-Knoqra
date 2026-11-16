import { describe, expect, it } from 'vitest';
import {
  type ControlRef,
  controlKey,
  DESTRUCTIVE,
  diffEffects,
  type EffectSnapshot,
  filterTargets,
  formatProblem,
  isDestructive,
  isOutward,
  linkProblem,
  noisyKeys,
  parseControls,
  promoteNoise,
} from './controls';
import { findKnownDefect, type KnownDefect } from './known-defects';
import type { RoutePattern, RouteTarget } from './routes';

describe('DESTRUCTIVE', () => {
  it.each([
    'Delete task',
    'Archive contact',
    'Archive',
    'Merge Dev Okonkwo',
    'Remove tag',
    'Revoke consent',
    'Revoke Chrome on Windows',
    'Sign out',
    'Sign out other devices',
    'Turn off two-factor',
    'Disable sync',
    'Reset filters',
    'Dismiss',
    'Dev Okonkwo is not the same person',
    'Stop and leave',
    'Do not contact',
    'Mark do not contact',
    'Opted out',
    'Record opt-out',
    'Opt out',
  ])('matches %s', (name) => {
    expect(DESTRUCTIVE.test(name)).toBe(true);
    expect(isDestructive(name)).toBe(true);
  });

  it.each([
    'Archived',
    'Merged contacts',
    'Signed out',
    'Restore contact',
    'Grant consent',
    'Keep importing',
    'Options',
    'Contact',
    'Cancel',
    'Settings',
    'Turn on',
  ])('leaves %s alone', (name) => {
    expect(isDestructive(name)).toBe(false);
  });

  it('also catches "Show merge history": the crawler blocks writes for it, but still activates it', () => {
    expect(isDestructive('Show merge history')).toBe(true);
  });
});

describe('isOutward', () => {
  it.each([
    'Send',
    'Send message',
    'Buy a number',
    'Buy +1 202 555 0150',
    'Buy for $2.00',
    'Purchase',
    'Release number',
    'Disconnect Telnyx',
    'Call',
    'Call back Marisol Quintero',
    'Place call',
    'Test call',
    'Start test call',
    'Hang up',
    'Add credit',
    'Save connection',
    'Connect Telnyx',
    'Connect',
    'Reconnect',
    'Release',
    'Call back Marisol',
    'Send now',
    'Start call',
  ])('treats %s as reaching outside', (name) => {
    expect(isOutward(name)).toBe(true);
  });

  it.each([
    'Calls',
    'Recent calls',
    'Sender',
    'Buyer notes',
    'Connected',
    'Connection',
    'Keypad',
    'Callers',
  ])('leaves %s alone', (name) => {
    expect(isOutward(name)).toBe(false);
  });
});

describe('noisyKeys', () => {
  it('keeps the subtrees still mutating near the end of the settle window', () => {
    const noise = {
      'span#clock': { count: 30, last: 2950 },
      'main > p': { count: 1, last: 120 },
      'div#ticker': { count: 4, last: 2300 },
    };
    expect(noisyKeys(noise, 3000, 1000)).toEqual(['div#ticker', 'span#clock']);
  });

  it('never masks the document or the page frame', () => {
    const noise = {
      body: { count: 9, last: 2990 },
      html: { count: 3, last: 2990 },
      '#root': { count: 2, last: 2990 },
      '#main': { count: 2, last: 2990 },
    };
    expect(noisyKeys(noise, 3000, 1000)).toEqual([]);
  });

  it('returns nothing when nothing churned', () => {
    expect(noisyKeys({}, 3000, 1000)).toEqual([]);
  });
});

describe('promoteNoise', () => {
  it('masks a subtree only once it churned through two settle windows', () => {
    const first = promoteNoise(new Map(), ['span#clock', 'main > div']);
    expect(first.promoted).toEqual([]);
    const second = promoteNoise(first.hits, ['span#clock']);
    expect(second.promoted).toEqual(['span#clock']);
    expect(second.hits.get('main > div')).toBe(1);
  });

  it('does not change the counts it was given', () => {
    const hits = new Map([['span#clock', 1]]);
    promoteNoise(hits, ['span#clock']);
    expect(hits.get('span#clock')).toBe(1);
  });
});

const SNAPSHOT = `- navigation "Primary":
  - link "Today":
    - /url: /
  - 'link "Ext: \\"quoted\\" link"':
    - /url: https://example.test/x?y=1#z
- 'button "Say: hi"'
- button "Off" [disabled]
- button "AriaOff" [disabled]
- button "More actions" [expanded]
- button "Close":
  - img
- tablist:
  - tab "All" [selected]
- menu:
  - menuitem "Sign out"
- link "Skip to content":
  - /url: "#main"
- button "Line one two"
- 'button "It''s - ''x'' [y] {z}"'
- text: nohref
- listbox:
  - option "Inbox" [selected]
- button "Close"
- button "Close" [disabled]
- button "Close"
- button
- checkbox "Trust this device"
- heading "Settings" [level=1]`;

describe('parseControls', () => {
  const controls = parseControls(SNAPSHOT);

  it('keeps buttons, links, menu items, tabs and options, in document order', () => {
    expect(controls.map(controlKey)).toEqual([
      'link "Today"',
      'link "Ext: "quoted" link"',
      'button "Say: hi"',
      'button "More actions"',
      'button "Close"',
      'tab "All"',
      'menuitem "Sign out"',
      'link "Skip to content"',
      'button "Line one two"',
      `button "It's - 'x' [y] {z}"`,
      'option "Inbox"',
      'button "Close" #2',
      'button "Close" #4',
      'button ""',
    ]);
  });

  it('reads link destinations, quoted or not', () => {
    expect(controls.find((c) => c.name === 'Today')?.href).toBe('/');
    expect(controls.find((c) => c.name === 'Skip to content')?.href).toBe('#main');
    expect(controls.find((c) => c.name.startsWith('Ext'))?.href).toBe(
      'https://example.test/x?y=1#z',
    );
    expect(controls.find((c) => c.role === 'button')?.href).toBeUndefined();
  });

  it('counts nth across disabled twins, so it lines up with getByRole().nth()', () => {
    const closes = controls.filter((c) => c.role === 'button' && c.name === 'Close');
    expect(closes.map((c) => c.nth)).toEqual([0, 1, 3]);
  });

  it('drops disabled and aria-disabled controls', () => {
    expect(controls.some((c) => c.name === 'Off' || c.name === 'AriaOff')).toBe(false);
  });

  it('skips the options of a native select, but counts them for nth', () => {
    const snap = [
      '- combobox "Timezone":',
      '  - option "Africa/Abidjan" [selected]',
      '  - option "Inbox"',
      '- listbox "Suggestions":',
      '  - option "Inbox"',
    ].join('\n');
    expect(parseControls(snap)).toEqual([{ role: 'option', name: 'Inbox', nth: 1 }]);
  });

  it('returns nothing for an empty snapshot', () => {
    expect(parseControls('')).toEqual([]);
  });
});

describe('controlKey', () => {
  it('numbers only repeated controls, counting from 1', () => {
    const first: ControlRef = { role: 'button', name: 'Revoke', nth: 0 };
    expect(controlKey(first)).toBe('button "Revoke"');
    expect(controlKey({ ...first, nth: 2 })).toBe('button "Revoke" #3');
  });
});

const BASE: EffectSnapshot = {
  url: 'http://localhost:5281/contacts',
  mutations: 10,
  fields: 'q=',
  focus: 2,
  clipboard: 0,
  requests: 5,
  dialogs: 0,
  expanded: 0,
  downloads: 0,
  popups: 0,
};

describe('diffEffects', () => {
  it('returns nothing when nothing moved: a dead control', () => {
    expect(diffEffects(BASE, { ...BASE })).toEqual([]);
  });

  it('names every counter that moved, in a fixed order', () => {
    const after: EffectSnapshot = {
      url: 'http://localhost:5281/contacts/ct_1',
      mutations: 11,
      fields: 'q=',
      focus: 3,
      clipboard: 1,
      requests: 6,
      dialogs: 1,
      expanded: 1,
      downloads: 1,
      popups: 1,
    };
    expect(diffEffects(BASE, after)).toEqual([
      'navigated',
      'request',
      'dom',
      'focus',
      'dialog',
      'expanded',
      'download',
      'popup',
      'clipboard',
    ]);
  });

  it('counts a form field taking a new value as a DOM change (a keypad digit, say)', () => {
    expect(diffEffects(BASE, { ...BASE, fields: 'q=1' })).toEqual(['dom']);
  });

  it('treats a hash change as navigation', () => {
    expect(diffEffects(BASE, { ...BASE, url: `${BASE.url}#main` })).toEqual(['navigated']);
  });

  it('counts a dialog or menu closing as an effect, not only opening', () => {
    const open = { ...BASE, dialogs: 1, expanded: 1 };
    expect(diffEffects(open, BASE)).toEqual(['dialog', 'expanded']);
  });

  it('notices counters that reset after a full page load', () => {
    expect(diffEffects(BASE, { ...BASE, mutations: 0, focus: 0 })).toEqual(['dom', 'focus']);
  });
});

const PATTERNS: RoutePattern[] = [
  { pattern: '/', auth: 'app' },
  { pattern: '/contacts', auth: 'app' },
  { pattern: '/contacts/$contactId', auth: 'app' },
  { pattern: '/calls', auth: 'app' },
  { pattern: '/sign-in', auth: 'public' },
];
const ORIGIN = 'http://localhost:5281';

describe('linkProblem', () => {
  const link = (href: string, target: string | null = null, rel: string | null = null) => ({
    href,
    target,
    rel,
  });

  it('accepts internal links to known routes, pending ones included', () => {
    expect(linkProblem(link(`${ORIGIN}/contacts/ct_9`), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link('/calls'), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link('/contacts/'), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link('/sign-in?next=%2F'), ORIGIN, PATTERNS)).toBeNull();
  });

  it('accepts in-page anchors and API downloads', () => {
    expect(linkProblem(link(`${ORIGIN}/contacts#main`), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link('/api/v1/contacts/export.csv'), ORIGIN, PATTERNS)).toBeNull();
  });

  it('flags internal links to unknown routes', () => {
    expect(linkProblem(link('/inboxx'), ORIGIN, PATTERNS)).toBe('links to unknown route /inboxx');
  });

  it('flags links that go nowhere', () => {
    expect(linkProblem(link(''), ORIGIN, PATTERNS)).toBe('link has an empty href');
    expect(linkProblem(link('javascript:void(0)'), ORIGIN, PATTERNS)).toBe(
      'link uses a javascript: URL',
    );
  });

  it('accepts mail and phone links', () => {
    expect(linkProblem(link('mailto:a@example.test'), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link('tel:+12025550101'), ORIGIN, PATTERNS)).toBeNull();
  });

  it('requires rel=noopener on external links that open a new tab', () => {
    const ext = 'https://docs.example.test/help';
    expect(linkProblem(link(ext), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link(ext, '_blank', 'noopener noreferrer'), ORIGIN, PATTERNS)).toBeNull();
    expect(linkProblem(link(ext, '_blank', 'noreferrer'), ORIGIN, PATTERNS)).toBe(
      `opens ${ext} in a new tab without rel="noopener"`,
    );
    expect(linkProblem(link(ext, '_blank'), ORIGIN, PATTERNS)).toBe(
      `opens ${ext} in a new tab without rel="noopener"`,
    );
  });
});

describe('formatProblem', () => {
  it('names the route, viewport and control', () => {
    const control: ControlRef = { role: 'button', name: 'Save', nth: 0 };
    expect(formatProblem('/settings', 'phone', control, [], 'dead')).toBe(
      '[/settings @ phone] button "Save": dead',
    );
  });

  it('names the triggers a nested control sits behind', () => {
    const item: ControlRef = { role: 'menuitem', name: 'Edit contact', nth: 0 };
    const trigger: ControlRef = { role: 'button', name: 'More actions', nth: 0 };
    expect(formatProblem('/contacts/$contactId (full)', 'desktop', item, [trigger], 'dead')).toBe(
      '[/contacts/$contactId (full) @ desktop] menuitem "Edit contact" (in button "More actions"): dead',
    );
  });

  it('labels page-level problems', () => {
    expect(formatProblem('/', 'desktop', null, [], 'HTTP 500 GET /api/v1/x')).toBe(
      '[/ @ desktop] page: HTTP 500 GET /api/v1/x',
    );
  });
});

describe('filterTargets', () => {
  const target = (pattern: string, label = pattern): RouteTarget => ({
    pattern,
    url: pattern,
    auth: 'app',
    label,
    throwaway: label.includes('throwaway'),
  });
  const all = [
    target('/sign-in'),
    target('/contacts'),
    target('/contacts/$contactId', '/contacts/$contactId (full)'),
    target('/contacts/$contactId', '/contacts/$contactId (throwaway)'),
  ];

  it('keeps everything without a filter', () => {
    expect(filterTargets(all, undefined)).toEqual(all);
    expect(filterTargets(all, ' ')).toEqual(all);
  });

  it('selects by pattern or by label', () => {
    expect(filterTargets(all, '/contacts').map((t) => t.label)).toEqual(['/contacts']);
    expect(
      filterTargets(all, '/sign-in, /contacts/$contactId (throwaway)').map((t) => t.label),
    ).toEqual(['/sign-in', '/contacts/$contactId (throwaway)']);
    expect(filterTargets(all, '/contacts/$contactId')).toHaveLength(2);
  });

  it('throws on an entry that matches nothing, so a typo cannot pass silently', () => {
    expect(() => filterTargets(all, '/contacts,/contcts')).toThrow(
      'KNOQRA_CRAWL_ROUTES: "/contcts" matches no route target',
    );
  });
});

describe('findKnownDefect', () => {
  const defects: KnownDefect[] = [
    {
      target: '/settings',
      control: 'button "Save"',
      problem: /dead/,
      ticket: '#101 settings save',
    },
    {
      target: '/contacts',
      viewport: 'phone',
      control: 'link "Import"',
      problem: /could not activate/,
      ticket: '#102 import link covered',
    },
  ];

  it('matches on target, control and problem', () => {
    expect(
      findKnownDefect(
        { target: '/settings', viewport: 'desktop', control: 'button "Save"', problem: 'dead: x' },
        defects,
      )?.ticket,
    ).toBe('#101 settings save');
  });

  it('respects an entry limited to one viewport', () => {
    const problem = {
      target: '/contacts',
      control: 'link "Import"',
      problem: 'could not activate: covered',
    };
    expect(findKnownDefect({ ...problem, viewport: 'phone' }, defects)).toBeDefined();
    expect(findKnownDefect({ ...problem, viewport: 'desktop' }, defects)).toBeUndefined();
  });

  it('without an index, excuses only the first control of that name, never #2', () => {
    const found = { target: '/settings', viewport: 'desktop' as const, problem: 'dead: x' };
    expect(findKnownDefect({ ...found, control: 'button "Save" #2' }, defects)).toBeUndefined();
  });

  it('with an index, excuses that exact control (also inside a container) and no other', () => {
    const indexed: KnownDefect[] = [
      { target: '/settings', control: 'button "Save" #2', problem: /dead/, ticket: 't' },
    ];
    const found = { target: '/settings', viewport: 'desktop' as const, problem: 'dead: x' };
    const match = (control: string) => findKnownDefect({ ...found, control }, indexed);
    expect(match('button "Save" #2')).toBeDefined();
    expect(match('button "Save" #2 (in button "More")')).toBeDefined();
    expect(match('button "Save"')).toBeUndefined();
    expect(match('button "Save" #3')).toBeUndefined();
    expect(match('button "Save" #20')).toBeUndefined();
  });

  it('does not excuse a different problem on the same control', () => {
    expect(
      findKnownDefect(
        { target: '/settings', viewport: 'desktop', control: 'button "Save"', problem: 'HTTP 500' },
        defects,
      ),
    ).toBeUndefined();
  });
});

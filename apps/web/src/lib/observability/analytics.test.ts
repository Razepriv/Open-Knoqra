import { beforeEach, describe, expect, it, vi } from 'vitest';

const ph = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));
const loaded = vi.hoisted(() => ({ count: 0 }));

vi.mock('posthog-js/dist/module.slim.no-external', () => {
  loaded.count += 1;
  return { default: ph, posthog: ph };
});

const CONFIG = { key: 'phc_test', host: 'https://us.i.posthog.com' };

/** analytics.ts keeps module state (loaded SDK, identified user), so each test gets a fresh copy. */
async function load() {
  return import('./analytics');
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of Object.values(ph)) fn.mockReset();
  loaded.count = 0;
});

const calls = vi.hoisted(() => ({ log: [] as string[] }));

describe('call order', () => {
  beforeEach(() => {
    calls.log = [];
    for (const [name, fn] of Object.entries(ph)) fn.mockImplementation(() => calls.log.push(name));
  });

  it('first consent: init, reset, opt in without an event, then identify', async () => {
    const { syncAnalytics } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(calls.log).toEqual(['init', 'reset', 'opt_in_capturing', 'identify']);
  });

  it('opt-out resets first so the stored opt-out survives', async () => {
    const { syncAnalytics } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    calls.log = [];
    await syncAnalytics(null, CONFIG);
    expect(calls.log).toEqual(['reset', 'opt_out_capturing']);
  });

  it('switching user: reset, opt in, identify', async () => {
    const { syncAnalytics } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    calls.log = [];
    await syncAnalytics({ userId: 'u2', consent: true }, CONFIG);
    expect(calls.log).toEqual(['reset', 'opt_in_capturing', 'identify']);
  });
});

describe('in-flight races', () => {
  it('consent revoked while the SDK loads: nothing is initialised or sent', async () => {
    const { syncAnalytics, track } = await load();
    const first = syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    const second = syncAnalytics({ userId: 'u1', consent: false }, CONFIG);
    await Promise.all([first, second]);
    expect(ph.init).not.toHaveBeenCalled();
    expect(ph.identify).not.toHaveBeenCalled();
    expect(track('contact_created', {})).toBe(false);
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it('opting out after a superseded load never touches the uninitialised SDK', async () => {
    const { syncAnalytics } = await load();
    const first = syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    const second = syncAnalytics(null, CONFIG);
    await Promise.all([first, second]);
    // The SDK chunk is now loaded, but init never ran.
    await syncAnalytics(null, CONFIG);
    expect(ph.init).not.toHaveBeenCalled();
    expect(ph.reset).not.toHaveBeenCalled();
    expect(ph.opt_out_capturing).not.toHaveBeenCalled();
  });

  it('user changes while the SDK loads: only the latest user is identified', async () => {
    const { syncAnalytics } = await load();
    const a = syncAnalytics({ userId: 'A', consent: true }, CONFIG);
    const b = syncAnalytics({ userId: 'B', consent: true }, CONFIG);
    await Promise.all([a, b]);
    expect(ph.identify).toHaveBeenCalledTimes(1);
    expect(ph.identify).toHaveBeenCalledWith('B');
  });

  it('a prototype key in props cannot throw', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(track('contact_created', { constructor: 'x' } as unknown as Record<string, never>)).toBe(
      false,
    );
  });
});

describe('stripUrlProperties', () => {
  it('removes URL-bearing properties, including in $set and $set_once', async () => {
    const { stripUrlProperties } = await load();
    const event = {
      event: 'page_viewed',
      properties: {
        route: '/contacts',
        $lib: 'web',
        distinct_id: 'u1',
        $current_url: 'https://x.test/a',
        $session_entry_url: 'https://x.test/',
        $session_entry_pathname: '/',
        utm_source: 'n',
        $initial_referrer: 'r',
        $set: { $current_url: 'u', plan: 'x' },
        $set_once: { $initial_current_url: 'u', $initial_utm_source: 's' },
      },
    };
    const out = stripUrlProperties(event);
    expect(out.properties).toEqual({
      route: '/contacts',
      $lib: 'web',
      distinct_id: 'u1',
      $set: { plan: 'x' },
      $set_once: {},
    });
    expect(out.event).toBe('page_viewed');
  });
});

describe('syncAnalytics and track', () => {
  it('never loads the SDK without config, and drops events', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, null);
    expect(loaded.count).toBe(0);
    expect(track('contact_created', {})).toBe(false);
  });

  it('does nothing without consent', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: false }, CONFIG);
    expect(ph.init).not.toHaveBeenCalled();
    expect(track('contact_created', {})).toBe(false);
  });

  it('drops events before the SDK has loaded', async () => {
    const { syncAnalytics, track } = await load();
    const pending = syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(track('contact_created', {})).toBe(false);
    await pending;
    expect(track('contact_created', {})).toBe(true);
  });

  it('initialises once with the private options and identifies the user', async () => {
    const { syncAnalytics, POSTHOG_OPTIONS } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(ph.init).toHaveBeenCalledTimes(1);
    const [key, options] = ph.init.mock.calls[0] ?? [];
    expect(key).toBe('phc_test');
    expect(options).toMatchObject({
      ...POSTHOG_OPTIONS,
      api_host: CONFIG.host,
      autocapture: false,
      disable_session_recording: true,
      capture_pageview: false,
    });
    expect(ph.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(ph.identify).toHaveBeenCalledTimes(1);
    expect(ph.identify).toHaveBeenCalledWith('u1');
  });

  it('sends allowed events with exactly their props', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(track('page_viewed', { route: '/contacts/$contactId' })).toBe(true);
    expect(ph.capture).toHaveBeenCalledWith('page_viewed', { route: '/contacts/$contactId' });
    expect(track('system_status_refreshed', { status: 'ok' })).toBe(true);
  });

  it('drops values that fail their rule or carry personal data', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(track('page_viewed', { route: '/x?q=ada@example.test' })).toBe(false);
    expect(track('page_viewed', { route: 'contacts' })).toBe(false);
    expect(track('page_viewed', { route: '/call/2025550123456' })).toBe(false);
    expect(track('system_status_refreshed', { status: 'bogus' as 'ok' })).toBe(false);
    expect(track('nope' as 'contact_created', {})).toBe(false);
    expect(track('contact_created', { extra: 'x' } as unknown as Record<string, never>)).toBe(
      false,
    );
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it('opts out on revoked consent or sign-out and drops later events', async () => {
    const { syncAnalytics, track } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    await syncAnalytics({ userId: 'u1', consent: false }, CONFIG);
    expect(ph.opt_out_capturing).toHaveBeenCalledTimes(1);
    // once after init (stale ids), once on opt-out
    expect(ph.reset).toHaveBeenCalledTimes(2);
    expect(track('contact_created', {})).toBe(false);

    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    expect(track('contact_created', {})).toBe(true);
    await syncAnalytics(null, CONFIG);
    expect(ph.opt_out_capturing).toHaveBeenCalledTimes(2);
    expect(track('contact_created', {})).toBe(false);
  });

  it('resets before identifying a different user', async () => {
    const { syncAnalytics } = await load();
    await syncAnalytics({ userId: 'u1', consent: true }, CONFIG);
    await syncAnalytics({ userId: 'u2', consent: true }, CONFIG);
    expect(ph.reset).toHaveBeenCalledTimes(2);
    expect(ph.identify).toHaveBeenLastCalledWith('u2');
    expect(ph.reset.mock.invocationCallOrder[1]).toBeLessThan(
      ph.identify.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it('opting out before the SDK ever loaded touches nothing', async () => {
    const { syncAnalytics } = await load();
    await syncAnalytics(null, CONFIG);
    expect(ph.opt_out_capturing).not.toHaveBeenCalled();
    expect(loaded.count).toBe(0);
  });
});

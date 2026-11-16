import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/lib/context';
import {
  CONSENT_LOOKUP_TIMEOUT_MS,
  captureForUser,
  createServerAnalytics,
} from '../src/observability/posthog';

const COUNTS = { created: 3, updated: 2, skipped: 1, rejected: 0 };

function spy(status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) => new Response('{}', { status }),
  );
}

describe('createServerAnalytics', () => {
  it('is a no-op without config and never calls fetch', async () => {
    const doFetch = spy();
    const analytics = createServerAnalytics(null, doFetch);
    expect(analytics.enabled).toBe(false);
    await expect(
      analytics.capture('contacts_import_batch', 'user-1', COUNTS),
    ).resolves.toBeUndefined();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('posts counts only, with no extra properties', async () => {
    const doFetch = spy();
    const analytics = createServerAnalytics(
      { key: 'phc_test', host: 'https://eu.i.posthog.com/' },
      doFetch,
    );
    expect(analytics.enabled).toBe(true);
    await analytics.capture('contacts_import_batch', 'user-1', COUNTS);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      api_key: 'phc_test',
      event: 'contacts_import_batch',
      distinct_id: 'user-1',
    });
    expect(body.properties).toEqual({
      ...COUNTS,
      $lib: 'knoqra-api',
      $process_person_profile: false,
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('resolves without throwing on a 500', async () => {
    const analytics = createServerAnalytics(
      { key: 'k', host: 'https://eu.i.posthog.com' },
      spy(500),
    );
    await expect(analytics.capture('contacts_import_batch', 'u', COUNTS)).resolves.toBeUndefined();
  });

  it('resolves without throwing when fetch rejects', async () => {
    const doFetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const analytics = createServerAnalytics(
      { key: 'k', host: 'https://eu.i.posthog.com' },
      doFetch,
    );
    await expect(analytics.capture('contacts_import_batch', 'u', COUNTS)).resolves.toBeUndefined();
  });

  it('drops unknown prop keys and non-integer values', async () => {
    const doFetch = spy();
    const analytics = createServerAnalytics(
      { key: 'k', host: 'https://eu.i.posthog.com' },
      doFetch,
    );
    const props = { ...COUNTS, email: 'a@example.test', skipped: -4 } as typeof COUNTS;
    await analytics.capture('contacts_import_batch', 'u', props);
    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body.properties).sort()).toEqual(
      ['$lib', '$process_person_profile', 'created', 'rejected', 'skipped', 'updated'].sort(),
    );
    expect(body.properties.skipped).toBe(0);
  });
});

describe('captureForUser', () => {
  const ON = { POSTHOG_KEY: 'phc_x', POSTHOG_HOST: 'https://eu.i.posthog.com' };

  function stubDb(rows: unknown[] | Promise<unknown[]>) {
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => rows }) }) }));
    return { select };
  }

  function fakeContext(env: Record<string, string>, db: unknown) {
    const waitUntil = vi.fn();
    const c = {
      env,
      var: { tenant: { userId: 'user-42', orgId: 'o1', role: 'owner' }, db },
      executionCtx: { waitUntil },
    } as unknown as Context<AppEnv>;
    return { c, waitUntil };
  }

  it('with consent: one waitUntil whose promise posts the counts for the user id', async () => {
    const db = stubDb([{ analyticsConsent: true }]);
    const { c, waitUntil } = fakeContext(ON, db);
    const doFetch = spy();
    await captureForUser(c, 'contacts_import_batch', COUNTS, doFetch);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(String(doFetch.mock.calls[0]?.[0])).toBe('https://eu.i.posthog.com/i/v0/e/');
    const body = JSON.parse(String(doFetch.mock.calls[0]?.[1]?.body));
    expect(body.distinct_id).toBe('user-42');
    expect(body.properties).toMatchObject(COUNTS);
  });

  it('without consent: no waitUntil and no fetch', async () => {
    const db = stubDb([{ analyticsConsent: false }]);
    const { c, waitUntil } = fakeContext(ON, db);
    const doFetch = spy();
    await captureForUser(c, 'contacts_import_batch', COUNTS, doFetch);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('without a prefs row (default opt-out): no waitUntil and no fetch', async () => {
    const { c, waitUntil } = fakeContext(ON, stubDb([]));
    const doFetch = spy();
    await captureForUser(c, 'contacts_import_batch', COUNTS, doFetch);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('PostHog off: never touches the database', async () => {
    const db = stubDb([{ analyticsConsent: true }]);
    const { c, waitUntil } = fakeContext({}, db);
    const doFetch = spy();
    await captureForUser(c, 'contacts_import_batch', COUNTS, doFetch);
    expect(db.select).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('swallows a failed consent lookup', async () => {
    const db = {
      select: vi.fn(() => {
        throw new Error('db down');
      }),
    };
    const { c, waitUntil } = fakeContext(ON, db);
    await expect(
      captureForUser(c, 'contacts_import_batch', COUNTS, spy()),
    ).resolves.toBeUndefined();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('skips the capture when the consent lookup stalls past 1 s', async () => {
    const { c, waitUntil } = fakeContext(ON, stubDb(new Promise<unknown[]>(() => undefined)));
    const doFetch = spy();
    const started = Date.now();
    await captureForUser(c, 'contacts_import_batch', COUNTS, doFetch);
    expect(Date.now() - started).toBeLessThan(CONSENT_LOOKUP_TIMEOUT_MS + 1500);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(doFetch).not.toHaveBeenCalled();
  });
});

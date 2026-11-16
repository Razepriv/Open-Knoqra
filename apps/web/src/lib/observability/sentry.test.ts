import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserOptions } from './sentry-sdk';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  tanstackRouterBrowserTracingIntegration: vi.fn(() => ({ name: 'TanstackRouterTracing' })),
}));

vi.mock('./sentry-sdk', () => sdk);

const CONFIG = {
  dsn: 'https://publickey@o1.ingest.sentry.io/42',
  release: 'abc',
  environment: 'test',
  tracesSampleRate: 0.05,
};

const router = { name: 'router' };

/** sentry.ts keeps module state (buffer, loaded SDK), so each test gets a fresh copy. */
async function load() {
  return import('./sentry');
}

function initOptions(): BrowserOptions {
  const options = sdk.init.mock.calls[0]?.[0] as BrowserOptions | undefined;
  if (!options) throw new Error('init was not called');
  return options;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('startSentry', () => {
  it('keeps the SDK behind a narrow re-export module', async () => {
    const source = readFileSync(new URL('./sentry.ts', import.meta.url), 'utf8');
    // A dynamic import of the package itself would keep its whole namespace (Replay, Feedback).
    expect(source).not.toMatch(/import\(\s*['"]@sentry\/react['"]\s*\)/);
    expect(source).toMatch(/import\(\s*['"]\.\/sentry-sdk['"]\s*\)/);
  });

  it('never loads or initialises the SDK without a config', async () => {
    const { startSentry, reportError } = await load();
    await startSentry(null, router);
    reportError(new Error('ignored'), { where: 'react' });
    expect(sdk.init).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('accepts reports before it starts', async () => {
    const { reportError } = await load();
    expect(() => reportError(new Error('early'))).not.toThrow();
    expect(() => reportError('not an error', { where: 'route' })).not.toThrow();
  });

  it('initialises once with private data collection and flushes buffered errors', async () => {
    const { startSentry, reportError } = await load();
    const early = new Error('before load');
    reportError(early, { where: 'react' });

    await startSentry(CONFIG, router);
    await startSentry(CONFIG, router);

    expect(sdk.init).toHaveBeenCalledTimes(1);
    const options = initOptions();
    expect(options).toMatchObject({
      dsn: CONFIG.dsn,
      release: 'abc',
      environment: 'test',
      tracesSampleRate: 0.05,
      tracePropagationTargets: [/^\/api\//],
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
      },
    });
    expect(sdk.tanstackRouterBrowserTracingIntegration).toHaveBeenCalledWith(router);
    expect(sdk.captureException).toHaveBeenCalledWith(early, { tags: { where: 'react' } });

    reportError(new Error('after load'));
    expect(sdk.captureException).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 20 errors before load', async () => {
    const { startSentry, reportError } = await load();
    for (let i = 0; i < 25; i += 1) reportError(new Error(`e${i}`));
    await startSentry(CONFIG, router);
    expect(sdk.captureException).toHaveBeenCalledTimes(20);
  });

  it('scrubs an email out of an exception value', async () => {
    const { startSentry } = await load();
    await startSentry(CONFIG, router);
    const event = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'No contact ada@example.test' }] },
    };
    const sent = await initOptions().beforeSend?.(event, {});
    expect(JSON.stringify(sent)).not.toContain('ada@example.test');
    expect(sent?.exception?.values?.[0]?.value).toBe('No contact [email]');
  });

  it('drops console breadcrumbs and scrubs the rest', async () => {
    const { startSentry } = await load();
    await startSentry(CONFIG, router);
    const { beforeBreadcrumb } = initOptions();
    expect(beforeBreadcrumb?.({ category: 'console', message: 'hi' })).toBeNull();
    expect(
      beforeBreadcrumb?.({ category: 'navigation', message: 'went to +1 202 555 0123' })?.message,
    ).toBe('went to [phone]');
  });

  it('drops every ui.* breadcrumb: element labels can carry contact names', async () => {
    const { startSentry } = await load();
    await startSentry(CONFIG, router);
    const { beforeBreadcrumb } = initOptions();
    expect(
      beforeBreadcrumb?.({
        category: 'ui.click',
        message: 'button.merge[aria-label="Merge Ada Example"]',
      }),
    ).toBeNull();
    expect(beforeBreadcrumb?.({ category: 'ui.input', message: 'input[name="q"]' })).toBeNull();
    expect(beforeBreadcrumb?.({ category: 'ui.keypress' })).toBeNull();
  });

  it('stays off and drops buffered errors when the SDK fails to load', async () => {
    sdk.init.mockImplementationOnce(() => {
      throw new Error('chunk failed');
    });
    const { startSentry, reportError } = await load();
    reportError(new Error('early'));
    await expect(startSentry(CONFIG, router)).rejects.toThrow('chunk failed');
    reportError(new Error('late'));
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});

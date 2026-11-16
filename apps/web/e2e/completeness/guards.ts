import type { Page } from '@playwright/test';

export interface ExpectedResponse {
  method?: string;
  path: RegExp;
  status: number;
  reason: string;
}
export interface PageWatch {
  problems(): string[];
  reset(): void;
  stop(): void;
}

/** True when an entry matches the method (any if omitted), the URL path and the exact status. */
export function isExplained(
  method: string,
  url: string,
  status: number,
  expected: readonly ExpectedResponse[],
): boolean {
  const path = new URL(url).pathname;
  return expected.some(
    (entry) =>
      entry.status === status &&
      (entry.method === undefined || entry.method.toUpperCase() === method.toUpperCase()) &&
      entry.path.test(path),
  );
}

/** Chromium logs every failed fetch as this console error; the response handler owns HTTP failures. */
export function isResourceLoadNoise(text: string): boolean {
  return /Failed to load resource/.test(text);
}

/** A request failure worth reporting: not an abort (superseded navigation, cancelled query). */
export function isReportableRequestFailure(errorText: string | undefined): boolean {
  return !(errorText ?? '').includes('net::ERR_ABORTED');
}

/** Attach before navigation. Adds an init script that reports 'unhandledrejection' as a console error tagged [unhandledrejection]. */
export function watchPage(page: Page, expected: readonly ExpectedResponse[]): PageWatch {
  let found: string[] = [];
  let active = true;
  const record = (message: string) => {
    if (active) found = [...found, message];
  };

  // Not awaited, so callers can stay synchronous: Playwright sends a page's commands in order, so
  // the script is registered before the caller's next navigation. A failure is recorded, not lost.
  page
    .addInitScript(() => {
      window.addEventListener('unhandledrejection', (event) => {
        // The guard surfaces rejections through the console channel it already listens to.
        // biome-ignore lint/suspicious/noConsole: intentional, runs inside the page under test
        console.error(`[unhandledrejection] ${String(event.reason)}`);
      });
    })
    .catch((error: unknown) => record(`init script failed: ${String(error)}`));

  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error' && !isResourceLoadNoise(msg.text())) {
      record(`console.error: ${msg.text()}`);
    }
  };
  const onRequestFailed = (request: {
    url(): string;
    method(): string;
    failure(): { errorText: string } | null;
  }) => {
    const errorText = request.failure()?.errorText;
    if (isReportableRequestFailure(errorText)) {
      record(`request failed: ${request.method()} ${request.url()} ${errorText ?? ''}`.trim());
    }
  };
  const onPageError = (error: Error) => record(`pageerror: ${error.message}`);
  const onResponse = (response: {
    status(): number;
    url(): string;
    request(): { method(): string };
  }) => {
    const status = response.status();
    if (status < 400) return;
    const method = response.request().method();
    if (!isExplained(method, response.url(), status, expected)) {
      record(`HTTP ${status} ${method} ${response.url()}`);
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    problems: () => found,
    reset: () => {
      found = [];
    },
    stop: () => {
      active = false;
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

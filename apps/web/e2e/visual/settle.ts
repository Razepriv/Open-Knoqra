import type { Page } from '@playwright/test';

const QUIET_MS = 250;
const GIVE_UP_MS = 8_000;

/**
 * The page has stopped changing: no loading status or skeleton glyphs left, no request in flight,
 * fonts loaded, and a short quiet spell. A page still loading after 8 s fails the test, so a
 * loading state can never be saved as a baseline. A request that never goes idle (a long poll) is
 * tolerated. The crawler has its own settle in `completeness/probe.ts`; it needs the crawler's
 * page probe installed, so this one stays separate.
 */
export async function waitForSettled(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[data-ascii-skeleton]') &&
        ![...document.querySelectorAll('[role="status"]')].some((el) =>
          /^(Loading|Checking)/.test(el.getAttribute('aria-label') ?? ''),
        ),
      undefined,
      { timeout: GIVE_UP_MS },
    )
    .catch(() => {
      throw new Error(`still loading after ${GIVE_UP_MS} ms; a loading state is not a baseline`);
    });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: GIVE_UP_MS }).catch(() => {});
  await page.waitForTimeout(QUIET_MS);
}

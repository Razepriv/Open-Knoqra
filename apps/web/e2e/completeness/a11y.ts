import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** WCAG 2.0, 2.1 and 2.2 levels A and AA: the bar every screen is held to. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING = new Set(['serious', 'critical']);
const SETTLE_MS = 8_000;

/**
 * No skeleton glyphs or loading status left, fonts loaded: the page is what a person would see.
 * Returns false when it was still loading at the deadline, so the scan can say so instead of
 * passing a loading state.
 */
async function settle(page: Page): Promise<boolean> {
  const settled = await page
    .waitForFunction(
      () =>
        !document.querySelector('[data-ascii-skeleton]') &&
        ![...document.querySelectorAll('[role="status"]')].some((el) =>
          /^(Loading|Checking)/.test(el.getAttribute('aria-label') ?? ''),
        ),
      undefined,
      { timeout: SETTLE_MS },
    )
    .then(() => true)
    .catch(() => false);
  await page.evaluate(() => document.fonts.ready);
  return settled;
}

/**
 * Everything wrong with the current page, as readable lines; empty when it is accessible. axe
 * serious and critical violations (id, impact, help and the first three targets), plus the two
 * landmark rules axe does not enforce for us: exactly one `<main>` and exactly one visible `<h1>`.
 * `landmarks: false` is for states that are not whole pages (an open menu keeps the page's own).
 */
export async function accessibilityProblems(
  page: Page,
  label: string,
  options: { landmarks?: boolean; allowLoading?: boolean } = {},
): Promise<string[]> {
  const problems: string[] = [];
  // `allowLoading` is for a page that shows loading placeholders on purpose (the UI showcase).
  if (!(await settle(page)) && !options.allowLoading)
    problems.push(`${label}: still loading after ${SETTLE_MS}ms`);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  for (const violation of results.violations) {
    if (!BLOCKING.has(violation.impact ?? '')) continue;
    const targets = violation.nodes
      .slice(0, 3)
      .map((node) => node.target.join(' '))
      .join(' | ');
    problems.push(
      `${label}: axe ${violation.id} (${violation.impact}) ${violation.help}: ${targets}`,
    );
  }
  if (options.landmarks !== false) {
    // A page that is still loading its data has no heading yet: give it the time axe was given.
    const headingShown = await page
      .locator('h1')
      .first()
      .waitFor({ state: 'visible', timeout: SETTLE_MS })
      .then(() => true)
      .catch(() => false);
    if (!headingShown) problems.push(`${label}: no <h1> after ${SETTLE_MS}ms`);
    const mains = await page.locator('main').count();
    if (mains !== 1) problems.push(`${label}: ${mains} <main> elements, expected 1`);
    const headings = await page.locator('h1').evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return box.width > 0 && box.height > 0 && style.visibility !== 'hidden';
        }).length,
    );
    if (headings !== 1) problems.push(`${label}: ${headings} visible <h1> elements, expected 1`);
  }
  return problems;
}

/** Fails with every problem found on the current page. */
export async function expectAccessible(page: Page, label: string): Promise<void> {
  expect(await accessibilityProblems(page, label), label).toEqual([]);
}

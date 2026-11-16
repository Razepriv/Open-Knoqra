import type { Locator, Page } from '@playwright/test';

/**
 * Regions whose text depends on when the run happens or on who signed up. Stable data is better
 * than a mask, so this list stays short: server timestamps (the page clock is frozen, the server
 * clock is not), relative times, and the random account email.
 */
export function volatileMasks(page: Page, email?: string): Locator[] {
  const masks = [
    page.locator('time'),
    page.getByText(/^Created [A-Z][a-z]{2} \d{1,2}, \d{4}$/),
    page.getByText(/\b(just now|\d+ (second|minute|hour|day|week|month|year)s? ago)\b/),
  ];
  if (email) {
    masks.push(page.getByText(email, { exact: true }), page.locator(`input[value="${email}"]`));
  }
  return masks;
}

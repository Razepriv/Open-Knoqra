import { expect, type Locator, type Page } from '@playwright/test';

/** What both Telnyx forms say when another workspace already claims the caller id (a 409). */
export const CALLER_ID_TAKEN = "This number can't be connected to this workspace.";

/** Room for a save plus the balance refresh that follows it, on a loaded machine. */
const SAVE_TIMEOUT = { timeout: 15_000 };
const ATTEMPTS = 5;

/**
 * A caller id belongs to one workspace at a time and the claim is global, so every run picks its
 * own: never a fake-number fixture (0100 to 0102), and clear of the low range API tests leave
 * claimed in a shared database. Specs free it with DELETE /api/v1/voice/connection after each test.
 */
export function randomCallerId(): string {
  return `+1202555${String(150 + Math.floor(Math.random() * 50)).padStart(4, '0')}`;
}

/**
 * Saves the Telnyx form in `scope` (the key and connection id already filled), trying another
 * caller id while the one picked is claimed by another workspace. Resolves once `saved` shows.
 */
export async function saveWithFreeCallerId(
  page: Page,
  scope: Page | Locator,
  saved: Locator,
): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    await scope.getByLabel('Caller id').fill(randomCallerId());
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/voice/connection') && r.request().method() === 'PUT',
      SAVE_TIMEOUT,
    );
    await scope.getByRole('button', { name: 'Save connection' }).click();
    if ((await response).status() !== 409) {
      await expect(saved).toBeVisible(SAVE_TIMEOUT);
      return;
    }
    await expect(scope.getByText(CALLER_ID_TAKEN)).toBeVisible();
  }
  throw new Error(
    `Every caller id tried in ${ATTEMPTS} attempts was claimed by another workspace.`,
  );
}

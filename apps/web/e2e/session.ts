import { expect, type Page } from '@playwright/test';

export const TEST_PASSWORD = 'correct-horse-battery';

let counter = 0;

/** A unique address per call, so parallel specs never share an account. */
export function uniqueEmail(prefix = 'e2e'): string {
  counter += 1;
  return `${prefix}+${Date.now()}-${counter}-${Math.floor(Math.random() * 1e6)}@example.test`;
}

/** Creates an account through the UI and waits for the signed-in desk. */
export async function signUp(
  page: Page,
  { name = 'Ana Silva', email = uniqueEmail() }: { name?: string; email?: string } = {},
): Promise<{ name: string; email: string }> {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('checkbox', { name: /I agree to the Terms/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  // Sign-up hashes a password and migrates a session on a shared dev machine: allow for load.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible({ timeout: 20_000 });
  return { name, email };
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

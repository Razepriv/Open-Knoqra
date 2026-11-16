import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

export const PASSWORD = 'correct-horse-battery';

export interface Account {
  email: string;
}

export function newAccount(): Account {
  return { email: `e2e+${randomUUID()}@example.test` };
}

export async function signUp(page: Page, account: Account, name = 'Ana Silva') {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).not.toHaveURL(/sign-up/);
}

export async function signIn(page: Page, account: Account) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function newSignedInContext(
  browser: Browser,
  account: Account,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/$/);
  return context;
}

export function codeFor(secret: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate();
}

export function securityRegion(page: Page) {
  return page.getByRole('region', { name: 'Security' });
}

/**
 * Turns two-factor on for the signed-in user on /settings and acknowledges the backup codes.
 * Returns the TOTP secret (read from the page, as a user typing it would) and the backup codes.
 */
export async function enableTwoFactor(page: Page): Promise<{ secret: string; codes: string[] }> {
  await page.goto('/settings');
  const security = securityRegion(page);
  await security.getByLabel('Confirm your password').fill(PASSWORD);
  await security.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = ((await security.getByTestId('totp-secret').textContent()) ?? '').replace(
    /\s+/g,
    '',
  );
  await security.getByLabel('Authentication code').fill(codeFor(secret));
  await security.getByRole('button', { name: 'Verify and enable' }).click();
  const codes = await readBackupCodes(page);
  await security.getByRole('button', { name: "I've saved these codes" }).click();
  await expect(security.getByText('Two-factor is on')).toBeVisible();
  return { secret, codes };
}

export async function readBackupCodes(page: Page): Promise<string[]> {
  const list = securityRegion(page).getByRole('list', { name: 'Backup codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  const items = await list.getByRole('listitem').allTextContents();
  return items.map((item) => item.trim());
}

/** Signs in as an account that has two-factor on and stops at the challenge. */
export async function signInToChallenge(page: Page, context: BrowserContext, account: Account) {
  await context.clearCookies();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/two-factor/);
}

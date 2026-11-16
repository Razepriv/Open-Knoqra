import { expect, test } from '@playwright/test';
import {
  codeFor,
  enableTwoFactor,
  newAccount,
  PASSWORD,
  readBackupCodes,
  securityRegion,
  signInToChallenge,
  signUp,
} from './helpers';

async function submitBackupCode(page: import('@playwright/test').Page, code: string) {
  await page.getByRole('button', { name: 'Use a backup code instead' }).click();
  await page.getByLabel('Backup code').fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
}

test.describe('reset link', () => {
  test('the token leaves the address bar but the reset still sends it', async ({ page }) => {
    let sentToken: string | undefined;
    await page.route('**/api/auth/reset-password', (route) => {
      sentToken = route.request().postDataJSON()?.token;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: true }),
      });
    });
    await page.goto('/reset-password?token=simulated-token');
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/token=/);
    expect(await page.evaluate(() => window.location.search)).toBe('');

    await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
    await page.getByLabel('Confirm new password').fill('a-brand-new-password');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page).toHaveURL(/sign-in/);
    expect(sentToken).toBe('simulated-token');
  });

  test('a failed attempt still leaves no token in the address bar', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token');
    await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
    await page.getByLabel('Confirm new password').fill('a-brand-new-password');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await expect(page.getByRole('alert')).toContainText('invalid or has expired');
    expect(page.url()).not.toContain('token=');
  });

  test('pages tell the browser not to send a referrer', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });
});

test.describe('two-factor backup codes', () => {
  test('a backup code works only once', async ({ page, context }) => {
    const account = newAccount();
    await signUp(page, account);
    const { codes } = await enableTwoFactor(page);
    const [first, second] = codes;
    if (!first || !second) throw new Error('expected backup codes');

    await signInToChallenge(page, context, account);
    await submitBackupCode(page, first);
    await expect(page).toHaveURL(/\/$/);

    await signInToChallenge(page, context, account);
    await submitBackupCode(page, first);
    await expect(page.getByRole('alert')).toContainText("That code didn't work");
    await expect(page).toHaveURL(/two-factor/);
    await page.getByLabel('Backup code').fill(second);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('new backup codes replace the old ones', async ({ page, context }) => {
    const account = newAccount();
    await signUp(page, account);
    const { codes: oldCodes } = await enableTwoFactor(page);

    await page.goto('/settings');
    const security = securityRegion(page);
    await security.getByLabel('Confirm your password').fill(PASSWORD);
    await security.getByRole('button', { name: 'New backup codes' }).click();
    const newCodes = await readBackupCodes(page);
    expect(newCodes.filter((code) => oldCodes.includes(code))).toEqual([]);
    await security.getByRole('button', { name: "I've saved these codes" }).click();

    const [oldFirst] = oldCodes;
    const [newFirst] = newCodes;
    if (!oldFirst || !newFirst) throw new Error('expected backup codes');
    await signInToChallenge(page, context, account);
    await submitBackupCode(page, oldFirst);
    await expect(page.getByRole('alert')).toContainText("That code didn't work");
    await page.getByLabel('Backup code').fill(newFirst);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test('"Trust this device" lets the next sign-in on this browser skip the challenge', async ({
  page,
  context,
}) => {
  const account = newAccount();
  await signUp(page, account);
  const { secret } = await enableTwoFactor(page);

  await signInToChallenge(page, context, account);
  await page.getByLabel('Trust this device for 30 days').check();
  await page.getByLabel('Authentication code').fill(codeFor(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/$/);

  // End the session but keep the browser's trust cookie, as signing out would.
  const trust = (await context.cookies()).filter((cookie) => cookie.name.includes('trust'));
  expect(trust.length).toBeGreaterThan(0);
  await context.clearCookies();
  await context.addCookies(trust);

  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test.describe('two-factor setup accessibility', () => {
  test('focus and announcements follow the setup phases', async ({ page }) => {
    await signUp(page, newAccount());
    await page.goto('/settings');
    const security = securityRegion(page);
    await security.getByLabel('Confirm your password').fill(PASSWORD);
    await security.getByRole('button', { name: 'Set up two-factor' }).click();

    await expect(security.getByLabel('Authentication code')).toBeFocused();
    await expect(security.getByRole('status').filter({ hasText: 'Scan the code' })).toBeAttached();

    const secret = ((await security.getByTestId('totp-secret').textContent()) ?? '').replace(
      /\s+/g,
      '',
    );
    await security.getByLabel('Authentication code').fill(codeFor(secret));
    await security.getByRole('button', { name: 'Verify and enable' }).click();

    await expect(security.getByRole('heading', { name: 'Your backup codes' })).toBeFocused();
    await expect(
      security.getByRole('status').filter({ hasText: 'Two-factor is on. Your backup codes' }),
    ).toBeAttached();
  });

  test('a QR code that cannot be drawn points to the manual key', async ({ page }) => {
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.toDataURL = () => {
        throw new Error('canvas blocked');
      };
    });
    await signUp(page, newAccount());
    await page.goto('/settings');
    const security = securityRegion(page);
    await security.getByLabel('Confirm your password').fill(PASSWORD);
    await security.getByRole('button', { name: 'Set up two-factor' }).click();
    await expect(
      security.getByText("Couldn't draw the QR code. Enter the key below instead."),
    ).toBeVisible();
    await expect(security.getByTestId('totp-secret')).toBeVisible();
  });
});

test.describe('settings error handling', () => {
  test('a failed account load shows an error with Try again, not skeletons forever', async ({
    page,
  }) => {
    await signUp(page, newAccount());
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ data: null, error: { code: 'no_active_org', message: 'No org.' } }),
      }),
    );
    await page.goto('/settings');
    await expect(page.getByRole('alert')).toContainText('We could not load your settings.');
    await expect(page.getByRole('status', { name: 'Loading your profile' })).toHaveCount(0);

    await page.unroute('**/api/v1/me');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByLabel('Name')).toBeVisible();
  });

  test('a half-failed profile save says which part failed and reloads from the server', async ({
    page,
  }) => {
    await signUp(page, newAccount());
    await page.goto('/settings');
    await page.route('**/api/v1/me/prefs', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'x' } }),
          })
        : route.continue(),
    );
    await page.getByLabel('Name').fill('Ana Maria Silva');
    await page.getByLabel('Time zone').selectOption('Europe/Lisbon');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert')).toContainText(
      "Your name was saved, but we couldn't save your time zone. Try again.",
    );

    await page.unroute('**/api/v1/me/prefs');
    await page.reload();
    await expect(page.getByLabel('Name')).toHaveValue('Ana Maria Silva');
    await expect(page.getByLabel('Time zone')).toHaveValue('');
  });
});

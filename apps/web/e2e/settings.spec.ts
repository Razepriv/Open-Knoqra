import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { codeFor, newAccount, newSignedInContext, PASSWORD, signIn, signUp } from './helpers';

test('name and time zone persist after a reload', async ({ page }) => {
  await signUp(page, newAccount());
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

  await page.getByLabel('Name').fill('Ana Maria Silva');
  await page.getByLabel('Time zone').selectOption('Europe/Lisbon');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Name')).toHaveValue('Ana Maria Silva');
  await expect(page.getByLabel('Time zone')).toHaveValue('Europe/Lisbon');
});

test('notification and theme preferences persist after a reload', async ({ page }) => {
  await signUp(page, newAccount());
  await page.goto('/settings');
  const desktop = page.getByLabel('Desktop notifications');
  await expect(desktop).toBeChecked(); // both notification kinds default to on
  await desktop.uncheck();
  await expect(page.getByText('Preferences saved')).toBeVisible();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.getByLabel('Desktop notifications')).not.toBeChecked();
  await expect(page.getByLabel('Email notifications')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('revoking a session signs that device out', async ({ browser, page }) => {
  const account = newAccount();
  await signUp(page, account);
  const other = await newSignedInContext(browser, account);
  try {
    await page.goto('/settings');
    const sessions = page.getByRole('list', { name: 'Signed-in devices' });
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
    await expect(sessions.getByText('This device')).toHaveCount(1);

    // Only the other device offers Revoke.
    await expect(sessions.getByRole('button', { name: /^Revoke/ })).toHaveCount(1);
    // The label says which device, from where and when, so two similar rows stay distinguishable.
    await expect(sessions.getByRole('button', { name: /^Revoke .+, .*(now|ago)/ })).toHaveCount(1);
    await sessions.getByRole('button', { name: /^Revoke/ }).click();
    await expect(sessions.getByRole('listitem')).toHaveCount(1);

    const otherPage = other.pages()[0];
    if (!otherPage) throw new Error('the second context has no page');
    await otherPage.goto('/');
    await expect(otherPage).toHaveURL(/sign-in/);
  } finally {
    await other.close();
  }
});

test('"Sign out other devices" keeps this device signed in', async ({ browser, page }) => {
  const account = newAccount();
  await signUp(page, account);
  const other = await newSignedInContext(browser, account);
  try {
    await page.goto('/settings');
    const sessions = page.getByRole('list', { name: 'Signed-in devices' });
    await expect(sessions.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Sign out other devices' }).click();
    await expect(sessions.getByRole('listitem')).toHaveCount(1);

    const otherPage = other.pages()[0];
    if (!otherPage) throw new Error('the second context has no page');
    await otherPage.goto('/');
    await expect(otherPage).toHaveURL(/sign-in/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  } finally {
    await other.close();
  }
});

test('two-factor: enable with a TOTP code, sign in with a code, then with a backup code, then disable', async ({
  page,
  context,
}) => {
  const account = newAccount();
  await signUp(page, account);
  await page.goto('/settings');

  const security = page.getByRole('region', { name: 'Security' });
  await security.getByLabel('Confirm your password').fill(PASSWORD);
  await security.getByRole('button', { name: 'Set up two-factor' }).click();

  await expect(
    security.getByRole('img', { name: 'QR code for your authenticator app' }),
  ).toBeVisible();
  const secret = ((await security.getByTestId('totp-secret').textContent()) ?? '').replace(
    /\s+/g,
    '',
  );
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  await security.getByLabel('Authentication code').fill(codeFor(secret));
  await security.getByRole('button', { name: 'Verify and enable' }).click();

  const codes = security.getByRole('list', { name: 'Backup codes' });
  await expect(codes.getByRole('listitem')).toHaveCount(10);
  const backupCode = ((await codes.getByRole('listitem').first().textContent()) ?? '').trim();
  expect(backupCode.length).toBeGreaterThanOrEqual(8);
  await expect(security.getByRole('button', { name: 'Copy codes' })).toBeVisible();
  await expect(security.getByRole('button', { name: 'Download codes' })).toBeVisible();
  await security.getByRole('button', { name: "I've saved these codes" }).click();
  await expect(codes).toHaveCount(0);
  await expect(security.getByText('Two-factor is on')).toBeVisible();

  // Sign in again: the password alone is no longer enough.
  await context.clearCookies();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByLabel('Authentication code').fill(codeFor(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/$/);

  // A backup code works once.
  await context.clearCookies();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByRole('button', { name: 'Use a backup code instead' }).click();
  await page.getByLabel('Backup code').fill(backupCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/$/);

  // Turn it off again: sign-in no longer asks for a code.
  await page.goto('/settings');
  await security.getByLabel('Confirm your password').fill(PASSWORD);
  await security.getByRole('button', { name: 'Turn off two-factor' }).click();
  await expect(security.getByRole('button', { name: 'Set up two-factor' })).toBeVisible();
  await context.clearCookies();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/$/);
});

test('a wrong two-factor code is rejected on the challenge page', async ({ page, context }) => {
  const account = newAccount();
  await signUp(page, account);
  await page.goto('/settings');
  const security = page.getByRole('region', { name: 'Security' });
  await security.getByLabel('Confirm your password').fill(PASSWORD);
  await security.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = ((await security.getByTestId('totp-secret').textContent()) ?? '').replace(
    /\s+/g,
    '',
  );
  await security.getByLabel('Authentication code').fill(codeFor(secret));
  await security.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(security.getByRole('list', { name: 'Backup codes' })).toBeVisible();

  await context.clearCookies();
  await signIn(page, account);
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText("That code didn't work");
  await expect(page).toHaveURL(/\/two-factor/);
});

test('the challenge page keeps a safe next target through sign-in', async ({ page, context }) => {
  const account = newAccount();
  await signUp(page, account);
  await page.goto('/settings');
  const security = page.getByRole('region', { name: 'Security' });
  await security.getByLabel('Confirm your password').fill(PASSWORD);
  await security.getByRole('button', { name: 'Set up two-factor' }).click();
  const secret = ((await security.getByTestId('totp-secret').textContent()) ?? '').replace(
    /\s+/g,
    '',
  );
  await security.getByLabel('Authentication code').fill(codeFor(secret));
  await security.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(security.getByRole('list', { name: 'Backup codes' })).toBeVisible();

  await context.clearCookies();
  await page.goto('/sign-in?next=/settings');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/two-factor/);
  await page.getByLabel('Authentication code').fill(codeFor(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test('forgot password shows the same neutral confirmation for any address', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/forgot-password/);
  // Vite's dev server can reload the page once when it first optimises a new dependency, which
  // would clear the field: retry the fill-and-submit step as a whole.
  await expect(async () => {
    await page.getByLabel('Email').fill(`nobody+${randomUUID()}@example.test`);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account exists, a reset link is on its way.')).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByText('The link expires soon.')).toBeVisible();
});

test('reset password rejects a link that is invalid or expired', async ({ page }) => {
  await page.goto('/reset-password?token=not-a-real-token');
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
  await page.getByLabel('Confirm new password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('alert')).toContainText('invalid or has expired');
});

test('reset password checks the length and the confirmation before asking the server', async ({
  page,
}) => {
  await page.goto('/reset-password?token=anything');
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByLabel('Confirm new password').fill('different');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByText('Use at least 12 characters.')).toBeVisible();
  await expect(page.getByText("The two passwords don't match.")).toBeVisible();
});

test('reset password without a token explains the link is incomplete', async ({ page }) => {
  await page.goto('/reset-password');
  await expect(page.getByText('This reset link is incomplete')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('a successful reset goes to sign-in with a confirmation toast', async ({ page }) => {
  // The reset email is covered by the API tests; here the server's answer is simulated.
  await page.route('**/api/auth/reset-password', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: true }),
    }),
  );
  await page.goto('/reset-password?token=simulated');
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
  await page.getByLabel('Confirm new password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page).toHaveURL(/sign-in/);
  await expect(page.getByRole('status').filter({ hasText: 'Password updated' })).toBeVisible();
  // The one-off flag is removed from the address once the toast is up.
  await expect(page).not.toHaveURL(/reset=/);
});

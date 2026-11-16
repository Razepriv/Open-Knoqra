import { expect, test } from '@playwright/test';

test('sign up lands on home with personal workspace, then sign out and back in', async ({
  page,
}) => {
  const email = `e2e+${Date.now()}@example.test`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
  // Ruling R5: the DOM text stays natural; CSS renders it in caps.
  await expect(page.getByText(/ana silva's workspace/i)).toBeVisible();
  // Sign out now lives in the account menu of the shell's top bar.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/sign-in/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText("That email and password don't match.")).toBeVisible();
});

test('protected home redirects to sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/sign-in/);
});

test('showcase renders the component kit and the theme toggle sets data-theme', async ({
  page,
}) => {
  await page.goto('/showcase');
  await expect(page.getByRole('heading', { name: 'Component kit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Primary' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light' })).toBeVisible();
});

async function signUp(page: import('@playwright/test').Page) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page.getByLabel('Email').fill(`e2e+${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
}

test('an unreachable API shows an outage state with retry instead of signing the user out', async ({
  page,
}) => {
  await signUp(page);
  await page.route('**/api/auth/get-session', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: "We can't reach KNOQRA right now" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/sign-in/);

  await page.unroute('**/api/auth/get-session');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
});

test('a 401 from the API sends the user to sign-in', async ({ page }) => {
  await signUp(page);
  // The first session check passes, so Home renders; every later one says "signed out".
  let checks = 0;
  await page.route('**/api/auth/get-session', (route) => {
    checks += 1;
    return checks === 1
      ? route.continue()
      : route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: { code: 'unauthorized', message: 'Sign in.' } }),
    }),
  );
  await page.goto('/');
  await expect(page).toHaveURL(/sign-in/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('field errors are announced through a polite live region', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const region = page.locator('[aria-live="polite"]').filter({ hasText: 'Enter an email address' });
  await expect(region).toBeVisible();
});

test('an expired session is explained on the sign-in page', async ({ page }) => {
  await page.goto('/sign-in?expired=true');
  const notice = page.getByRole('status').filter({ hasText: 'Your session ended' });
  await expect(notice).toHaveText('Your session ended. Sign in again to continue.');
  await expect(notice).toHaveAttribute('aria-live', 'polite');
  await page.goto('/sign-in');
  await expect(page.getByText('Your session ended')).toHaveCount(0);
});

test('a failed API request shows the outage state, then recovers on retry', async ({ page }) => {
  await signUp(page);
  await page.route('**/api/v1/me', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: "We can't reach KNOQRA right now" }),
  ).toBeVisible();
  await page.unroute('**/api/v1/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
});

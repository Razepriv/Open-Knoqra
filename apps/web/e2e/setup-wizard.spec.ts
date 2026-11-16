import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { saveWithFreeCallerId } from './voice-helpers';

// Runs on the fake provider: numbers come from the fake account and the test call goes through the
// real pipeline (dev events, queue, state machine, realtime), so state changes get a longer timeout.
const PIPELINE = { timeout: 15_000 };
test.describe.configure({ timeout: 90_000 });

const steps = (page: Page) => page.getByRole('list', { name: 'Setup steps' });
const stepButton = (page: Page, name: string | RegExp) => steps(page).getByRole('button', { name });
const stepHeading = (page: Page, name: string) =>
  page.getByRole('heading', { level: 2, name, exact: true });

async function connectTelnyx(page: Page): Promise<void> {
  await page.getByLabel('API key').fill('KEY0123456789ABCDEFtestonly');
  await page.getByLabel('Credential connection id').fill('conn-test');
  await saveWithFreeCallerId(page, page, page.getByText('••••only'));
}

test.afterEach(async ({ page }) => {
  // Frees the caller id claim, pass or fail. A test that never signed in gets a 401, which is fine.
  await page.request.delete('/api/v1/voice/connection');
});

async function syncAndAssign(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sync from Telnyx' }).click();
  await expect(page.getByRole('radio')).toHaveCount(3, PIPELINE);
  await page.getByRole('radio', { name: /\+1 202 555 0100/ }).check();
  await page.getByRole('button', { name: 'Use for calls and messages' }).click();
}

test('the wizard walks connect, number, audio and test call, and resumes from the server', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/setup');
  await expect(stepHeading(page, 'Connect Telnyx')).toBeVisible();
  await expect(
    page.getByText('Stored encrypted. KNOQRA never shows the full key again.'),
  ).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveAttribute('type', 'password');
  await connectTelnyx(page);
  await expect(page.getByRole('status').filter({ hasText: 'Telnyx credential' })).toContainText(
    'Saved',
    PIPELINE,
  );

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page, 'Choose a number')).toBeVisible();
  await syncAndAssign(page);

  await expect(stepHeading(page, 'Test audio')).toBeVisible(PIPELINE);
  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(page.getByRole('meter', { name: 'Microphone level' })).toBeVisible();
  await page.getByRole('button', { name: 'Play test tone' }).click();
  await expect(page.getByText('Did you hear the tone?').first()).toBeVisible(PIPELINE);
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByText('Audio checked.')).toBeVisible(PIPELINE);

  await stepButton(page, /Test call/).click();
  await expect(stepHeading(page, 'Test call')).toBeVisible();
  await page.getByLabel('A phone you own').fill('+12025550123');
  await page.getByLabel("I own this number and I'm authorized to call it").check();
  await page.getByRole('button', { name: 'Call', exact: true }).click();
  // The call dock also offers Hang up on this page; the step's own is the one under test.
  const step = page.getByRole('region', { name: 'Test call', exact: true });
  await expect(step.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible(PIPELINE);
  await step.getByRole('button', { name: 'Hang up' }).click();
  const outcome = page.getByRole('dialog', { name: 'How did it go?' });
  await expect(outcome).toBeVisible(PIPELINE);
  await outcome.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByText("Test call complete. You're ready to call.")).toBeVisible(PIPELINE);

  await page.goto('/setup');
  for (const label of ['Connect Telnyx', 'Choose a number', 'Test audio', 'Test call']) {
    await expect(stepButton(page, `${label} (done)`)).toBeVisible(PIPELINE);
  }
  await expect(page.getByRole('region', { name: 'Setup complete' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Calls' })).toBeVisible();
});

test('leaving at the number step and reopening /setup resumes there', async ({ page }) => {
  await signUp(page);
  await page.goto('/setup');
  await connectTelnyx(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(stepHeading(page, 'Choose a number')).toBeVisible();
  // The step change saves where the person was; wait for it before leaving.
  await expect
    .poll(async () => {
      const response = await page.request.get('/api/v1/setup');
      const body = (await response.json()) as { data: { lastStep: string | null } };
      return body.data.lastStep;
    }, PIPELINE)
    .toBe('number');

  await page.goto('/setup');
  await expect(stepHeading(page, 'Choose a number')).toBeVisible(PIPELINE);
});

test('a blocked microphone says so and offers Try again', async ({ page }) => {
  await page.addInitScript(() => {
    const reject = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: reject,
    });
  });
  await signUp(page);
  await page.goto('/setup?step=audio');
  await page.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    page.getByText('Microphone blocked. Allow microphone access for this site, then try again.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

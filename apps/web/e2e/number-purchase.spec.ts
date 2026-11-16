import { expect, type Page, test } from '@playwright/test';
import { signUp } from './session';
import { PIPELINE } from './usage-helpers';

// Runs on the fake provider: area code 202 offers +1 202 555 0150 to 0159 at $1.00 up front and
// $1.00 a month, and an order for a number ending 0159 fails. A bought number is claimed by one
// workspace for good, so every test buys its own number and the runs clear the route table first.
// Serial: five sign-ups at once starve the API for the other specs that share the 3 workers.
test.describe.configure({ timeout: 90_000, mode: 'serial' });

const CHARGE_MICROS = 2_000_000;

// A caller id belongs to one workspace at a time and the claim is global, so every run picks its own
// from the high end of the range, away from the numbers these tests buy (0150 to 0159).
function randomCallerId(): string {
  return `+1202555${String(170 + Math.floor(Math.random() * 30)).padStart(4, '0')}`;
}

// Sign-up hashing is CPU heavy. Started together, three first sign-ups leave the other specs' first
// page loads waiting past their 5 s expectations, so this serial spec starts a little later.
test.beforeAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 12_000));
});

test.afterEach(async ({ page }) => {
  // Frees the caller id claim, pass or fail. A test that never signed in gets a 401, which is fine.
  await page.request.delete('/api/v1/voice/connection');
});

async function connectTelnyx(page: Page): Promise<void> {
  await page.getByLabel('API key').fill('KEY0123456789ABCDEFtestonly');
  await page.getByLabel('Credential connection id').fill('conn-test');
  const taken = page.getByText('This number is connected to another workspace');
  const saved = page.getByText('••••only');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.getByLabel('Caller id').fill(randomCallerId());
    await page.getByRole('button', { name: 'Save connection' }).click();
    await expect(saved.or(taken)).toBeVisible(PIPELINE);
    if (await saved.isVisible()) return;
  }
  await expect(saved).toBeVisible();
}

async function signUpAndConnect(page: Page): Promise<void> {
  await signUp(page);
  await page.goto('/setup');
  await connectTelnyx(page);
  await expect(page.getByRole('status').filter({ hasText: 'Telnyx credential' })).toContainText(
    'Saved',
    PIPELINE,
  );
}

async function available(page: Page): Promise<number> {
  const response = await page.request.get('/api/v1/wallet');
  const body = (await response.json()) as { data: { availableMicros: number } };
  return body.data.availableMicros;
}

interface LedgerRow {
  kind: string;
  refType: string | null;
  balanceDeltaMicros: number;
}

async function numberLedger(page: Page): Promise<LedgerRow[]> {
  const response = await page.request.get('/api/v1/usage/ledger?limit=50');
  const body = (await response.json()) as { data: { items: LedgerRow[] } };
  return body.data.items.filter((row) => row.refType === 'number_order');
}

async function search(page: Page): Promise<void> {
  await page.getByLabel('Area code').fill('202');
  await expect(page.getByRole('list', { name: 'Available numbers' })).toBeVisible(PIPELINE);
}

const resultRow = (page: Page, e164: string) =>
  page
    .getByRole('list', { name: 'Available numbers' })
    .getByRole('listitem')
    .filter({ hasText: e164 });

test('the owner searches, confirms $2.00 and buys a number on the Numbers page', async ({
  page,
}) => {
  await signUpAndConnect(page);
  await page.goto('/numbers');
  const before = await available(page);

  await page.getByRole('button', { name: 'Buy a number' }).click();
  await search(page);
  await expect(page.getByRole('listitem').filter({ hasText: '$1.00 one-time' })).toHaveCount(10);
  await expect(resultRow(page, '+1 202 555 0150')).toContainText('$1.00 one-time · $1.00/month');

  const trigger = page.getByRole('button', { name: 'Buy +1 202 555 0150' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Buy this number' });
  await expect(dialog).toContainText('+1 202 555 0150');
  await expect(dialog).toContainText('Total charged now');
  await expect(dialog).toContainText(
    'Charged to your KNOQRA wallet now. Telnyx bills you the same amount.',
  );
  await dialog.getByRole('button', { name: 'Buy for $2.00' }).click();
  await expect(dialog.getByText('Number bought and set for calls and messages.')).toBeVisible(
    PIPELINE,
  );
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Buy a number' })).toBeFocused();

  await expect(
    page.getByRole('combobox', { name: 'Assigned use for +1 202 555 0150' }),
  ).toHaveValue('calls_and_messages', PIPELINE);
  expect(await available(page)).toBe(before - CHARGE_MICROS);

  const charges = await numberLedger(page);
  expect(charges.find((row) => row.kind === 'capture')?.balanceDeltaMicros).toBe(-CHARGE_MICROS);

  await page.goto('/usage');
  const ledger = page.getByRole('list', { name: 'Ledger', exact: true });
  await expect(ledger).toContainText('-$2.00', PIPELINE);
  await expect(ledger).toContainText('Number charge');
});

test('a double click on Buy charges once', async ({ page }) => {
  await signUpAndConnect(page);
  await page.goto('/numbers');
  const before = await available(page);
  await page.getByRole('button', { name: 'Buy a number' }).click();
  await search(page);
  await page.getByRole('button', { name: 'Buy +1 202 555 0152' }).click();
  const dialog = page.getByRole('dialog', { name: 'Buy this number' });
  // The second click may land on the Done button that replaces Buy, so the dialog's own state is not
  // asserted here: the ledger and the wallet are the truth.
  await dialog.getByRole('button', { name: 'Buy for $2.00' }).dblclick();
  await expect
    .poll(async () => (await numberLedger(page)).filter((row) => row.kind === 'capture').length, {
      timeout: 15_000,
    })
    .toBe(1);
  expect(await available(page)).toBe(before - CHARGE_MICROS);
  const orders = await page.request.get('/api/v1/numbers/orders');
  const body = (await orders.json()) as { data: { items: { status: string }[] } };
  expect(body.data.items).toHaveLength(1);
});

test('a number the provider refuses says nothing was charged and leaves the wallet alone', async ({
  page,
}) => {
  await signUpAndConnect(page);
  await page.goto('/numbers');
  const before = await available(page);
  await page.getByRole('button', { name: 'Buy a number' }).click();
  await search(page);
  await page.getByRole('button', { name: 'Buy +1 202 555 0159' }).click();
  const dialog = page.getByRole('dialog', { name: 'Buy this number' });
  await dialog.getByRole('button', { name: 'Buy for $2.00' }).click();
  await expect(
    dialog.getByText("Telnyx couldn't complete this order. Nothing was charged."),
  ).toBeVisible(PIPELINE);
  await expect(dialog.getByRole('button', { name: 'Search again' })).toBeVisible();
  expect(await available(page)).toBe(before);
  expect((await numberLedger(page)).filter((row) => row.kind === 'capture')).toHaveLength(0);

  await dialog.getByRole('button', { name: 'Search again' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Area code')).toBeFocused();
});

test('another area code lists its own numbers', async ({ page }) => {
  await signUpAndConnect(page);
  await page.goto('/numbers');
  await page.getByRole('button', { name: 'Buy a number' }).click();
  await page.getByLabel('Area code').fill('202');
  await expect(page.getByRole('list', { name: 'Available numbers' })).toBeVisible(PIPELINE);
  await page.getByLabel('Area code').fill('303');
  await expect(page.getByText('+1 303 555 0150')).toBeVisible(PIPELINE);
});

test('the setup wizard offers Get a number and finishes the step after a purchase', async ({
  page,
}) => {
  await signUpAndConnect(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Choose a number', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Get a number' }).click();
  await search(page);
  await page.getByRole('button', { name: 'Buy +1 202 555 0151' }).click();
  const dialog = page.getByRole('dialog', { name: 'Buy this number' });
  await dialog.getByRole('button', { name: 'Buy for $2.00' }).click();
  await expect(dialog.getByText('Number bought and set for calls and messages.')).toBeVisible(
    PIPELINE,
  );
  await dialog.getByRole('button', { name: 'Done' }).click();

  await expect(
    page.getByRole('heading', { level: 2, name: 'Test audio', exact: true }),
  ).toBeVisible(PIPELINE);
  await expect(
    page
      .getByRole('list', { name: 'Setup steps' })
      .getByRole('button', { name: 'Choose a number (done)' }),
  ).toBeVisible(PIPELINE);
});

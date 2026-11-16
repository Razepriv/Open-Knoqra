import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/contacts.csv', import.meta.url));

async function signUp(page: Page) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page.getByLabel('Email').fill(`e2e+robust${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
}

async function upload(page: Page, file: string | { name: string; buffer: Buffer }) {
  await page.goto('/contacts/import');
  await page
    .getByLabel('Choose a CSV file')
    .setInputFiles(
      typeof file === 'string'
        ? file
        : { name: file.name, mimeType: 'text/csv', buffer: file.buffer },
    );
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
}

async function importFromMapStep(page: Page, label = 'Import 6 contacts') {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: label }).click();
}

const serverError = {
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({
    data: null,
    error: { code: 'internal_error', message: 'Server exploded.' },
  }),
};

test('a rejected-rows download can be uploaded again and keeps its phone numbers', async ({
  page,
}) => {
  await signUp(page);
  await upload(page, fixture);
  await importFromMapStep(page);
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download rejected rows (CSV)' }).click();
  const path = await (await downloadPromise).path();

  await page.getByRole('button', { name: 'Import another file' }).click();
  await page.getByLabel('Choose a CSV file').setInputFiles(path);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Import 2 contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();

  // Katherine's phone survived the export guard: only her bad email is still the problem.
  const rejected = page.getByRole('table', { name: 'Rejected rows' });
  const katherine = rejected.getByRole('row', { name: /Katherine Johnson/ });
  await expect(katherine).toContainText('+12025550104');
  await expect(katherine).toContainText('Email is not valid');
  await expect(katherine).not.toContainText('phone');
});

test('a Windows-1252 file is read correctly and flagged', async ({ page }) => {
  await signUp(page);
  const bytes = Buffer.concat([
    Buffer.from('Name,Phone\nZo'),
    Buffer.from([0xeb]),
    Buffer.from(',+12025550131\n'),
  ]);
  await upload(page, { name: 'latin.csv', buffer: bytes });
  await expect(
    page.getByText(
      "This file isn't UTF-8; we read it as Windows-1252. Check accented names in the preview.",
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('cell', { name: 'Zoë' })).toBeVisible();
});

test('a quoted value that never closes is explained on the upload step', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'broken.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Phone\n"Ada,+12025550101\nGrace,+12025550102\n'),
  });
  await expect(page.getByRole('alert')).toContainText('quoted value');
});

test('a first row that looks like a contact is flagged', async ({ page }) => {
  await signUp(page);
  await upload(page, {
    name: 'nohead.csv',
    buffer: Buffer.from('Ada,+12025550101\nGrace,+12025550102\n'),
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'first row looks like contact data' }),
  ).toBeVisible();
});

test('First Name and Last Name columns are joined into the name', async ({ page }) => {
  await signUp(page);
  await upload(page, {
    name: 'split.csv',
    buffer: Buffer.from('First Name,Last Name,Mobile\nAda,Lovelace,+12025550141\n'),
  });
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Last name', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('cell', { name: 'Ada Lovelace' })).toBeVisible();
});

test('mapping one column to two fields shows a warning', async ({ page }) => {
  await signUp(page);
  await upload(page, fixture);
  await page.getByLabel('Email', { exact: true }).selectOption({ label: 'Name' });
  await expect(
    page.getByRole('status').filter({ hasText: 'is used for Name and Email' }),
  ).toBeVisible();
});

test('row numbers follow the file: blank lines count, quoted line breaks do not', async ({
  page,
}) => {
  await signUp(page);
  await upload(page, {
    name: 'gaps.csv',
    buffer: Buffer.from('Name,Phone\n\nAda,\n"Multi\nline",+12025550151\n\n\nGrace,\n'),
  });
  await importFromMapStep(page, 'Import 3 contacts');
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  const rejected = page.getByRole('table', { name: 'Rejected rows' });
  await expect(rejected.getByRole('row', { name: /Ada/ }).getByRole('cell').first()).toHaveText(
    '3',
  );
  await expect(rejected.getByRole('row', { name: /Grace/ }).getByRole('cell').first()).toHaveText(
    '7',
  );
});

test('the heading does not take focus on first load, but does on a step change', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upload a CSV' })).not.toBeFocused();
  await page.getByLabel('Choose a CSV file').setInputFiles(fixture);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeFocused();
});

test('a file dropped outside the dropzone does not make the browser open it', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['x'], 'x.csv'));
    const event = new DragEvent('drop', {
      dataTransfer: transfer,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
});

test('the dropzone label is plain readable text', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await expect(page.getByText('Choose a CSV file', { exact: true })).toBeVisible();
  await expect(
    page.getByText('or drop it here. Nothing is sent until you confirm the import.'),
  ).toBeVisible();
});

test('a failing server stops the import with the partial results and a way to finish', async ({
  page,
}) => {
  await signUp(page);
  await upload(page, fixture);
  let calls = 0;
  await page.route('**/api/v1/contacts/import', (route) => {
    calls += 1;
    return route.fulfill(serverError);
  });
  await importFromMapStep(page);
  await expect(page.getByRole('heading', { name: 'Import stopped' })).toBeVisible({
    timeout: 20_000,
  });
  expect(calls).toBe(2); // one automatic retry
  await expect(page.getByRole('alert')).toHaveText('Server exploded.');
  await expect(page.getByText('Rows 2 onward may or may not have been imported.')).toBeVisible();
  await expect(
    page.getByText("Run the file again with 'Skip existing' to finish safely"),
  ).toBeVisible();
  await expect(page.getByTestId('count-created')).toHaveText('0');
});

test('a batch that fails once is retried and the import carries on', async ({ page }) => {
  await signUp(page);
  await upload(page, fixture);
  let calls = 0;
  await page.route('**/api/v1/contacts/import', (route) => {
    calls += 1;
    return calls === 1 ? route.fulfill({ ...serverError, status: 503 }) : route.continue();
  });
  await importFromMapStep(page);
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('count-created')).toHaveText('3');
});

test('an unreachable server is reported in plain words, not as "Failed to fetch"', async ({
  page,
}) => {
  await signUp(page);
  await upload(page, fixture);
  await page.route('**/api/v1/contacts/import', (route) => route.abort('connectionrefused'));
  await importFromMapStep(page);
  await expect(page.getByRole('heading', { name: 'Import stopped' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole('alert')).toHaveText("We couldn't reach KNOQRA.");
});

test('a session that ends mid-import sends the user to sign-in instead of stalling', async ({
  page,
}) => {
  await signUp(page);
  await upload(page, fixture);
  await page.route('**/api/v1/contacts/import', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ data: null, error: { code: 'unauthenticated', message: 'Sign in.' } }),
    }),
  );
  await importFromMapStep(page);
  await expect(page).toHaveURL(/sign-in/);
});

test('leaving the page during a running import asks first, and keeping on carries the run to its results', async ({
  page,
}) => {
  await signUp(page);
  // 1,100 rows is three batches, so the run is still going when the rail is clicked.
  const lines = Array.from(
    { length: 1100 },
    (_, i) => `Person ${i},+1202555${String(i).padStart(4, '0')}`,
  );
  await upload(page, { name: 'big.csv', buffer: Buffer.from(`Name,Phone\n${lines.join('\n')}\n`) });

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await page.route('**/api/v1/contacts/import', async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Import 1,100 contacts' }).click();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Contacts' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Leave and stop the import?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Rows already sent stay imported.');
  await expect(dialog.getByRole('button', { name: 'Keep importing' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Keep importing' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/contacts\/import$/);

  release();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('count-created')).toHaveText('1,100');
});

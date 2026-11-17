import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const fixture = fileURLToPath(new URL('./fixtures/contacts.csv', import.meta.url));

async function signUp(page: Page) {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Ana Silva');
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`e2e+import${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('checkbox', { name: /I agree to the Terms/ }).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
}

async function uploadFixture(page: Page) {
  await page.goto('/contacts/import');
  await page.getByLabel('Choose a CSV file').setInputFiles(fixture);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
}

test('import wizard: upload, map, review, run and download the rejected rows', async ({ page }) => {
  await signUp(page);
  await uploadFixture(page);

  // Auto-mapping picks the right column for each field; Continue is enabled.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('Company', { exact: true })).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Job title', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('Time zone', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Tags', { exact: true })).toHaveValue('6');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Review before importing' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Skip existing/ })).toBeChecked();
  await page.getByRole('button', { name: 'Import 6 contacts' }).click();

  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await expect(page.getByTestId('count-created')).toHaveText('3');
  await expect(page.getByTestId('count-rejected')).toHaveText('2');
  await expect(page.getByTestId('count-skipped')).toHaveText('1');

  // File-level numbering: the header is row 1, so the data rows are 2..7.
  const rejected = page.getByRole('table', { name: 'Rejected rows' });
  await expect(rejected.getByRole('row', { name: /Margaret Hamilton/ })).toContainText(
    'Phone is required',
  );
  await expect(rejected.getByRole('row', { name: /Katherine Johnson/ })).toContainText(
    'Email is not valid',
  );
  await expect(
    page.getByRole('table', { name: 'Skipped rows' }).getByRole('row', { name: /Again/ }),
  ).toContainText('Duplicate of row 2');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download rejected rows (CSV)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('contacts-rejected.csv');
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  // The file starts with a byte order mark so Excel reads it as UTF-8.
  expect(text.startsWith('﻿')).toBe(true);
  const [header, ...lines] = text.slice(1).split('\r\n');
  expect(header).toBe('Name,Phone,Company,Email,Title,Timezone,Tags,Row,Reason');
  expect(lines).toHaveLength(2);
  expect(lines.join('\n')).toContain('Phone is required');
  expect(lines.join('\n')).toContain('Email is not valid');

  await expect(page.getByRole('link', { name: 'View contacts' })).toHaveAttribute(
    'href',
    '/contacts',
  );

  // The imported contacts carry source "import". (Contact 360 itself is another screen.)
  const response = await page.request.get('/api/v1/contacts?limit=50');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    data: { items: { displayName: string; source: string }[] };
  };
  const names = body.data.items.map((item) => item.displayName).sort();
  expect(names).toEqual(['Ada Lovelace', 'Alan Turing', 'Grace Hopper']);
  expect(body.data.items.every((item) => item.source === 'import')).toBe(true);
});

test('Continue stays disabled until Name and Phone are mapped', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'odd.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('who,digits\nAda,+12025550111\n'),
  });
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByLabel('Name', { exact: true }).selectOption({ label: 'who' });
  await expect(cont).toBeDisabled();
  await page.getByLabel('Phone', { exact: true }).selectOption({ label: 'digits' });
  await expect(cont).toBeEnabled();
});

test('a file that is not a usable CSV is explained on the upload step', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts/import');
  await page.getByLabel('Choose a CSV file').setInputFiles({
    name: 'empty.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Phone\n'),
  });
  await expect(page.getByRole('alert')).toContainText('no contacts');
  await expect(page.getByRole('heading', { name: 'Upload a CSV' })).toBeVisible();
});

test('import requires a signed-in user', async ({ page }) => {
  await page.goto('/contacts/import');
  await expect(page).toHaveURL(/sign-in/);
});

import { expect, test } from '@playwright/test';
import { EXPECTED_RESPONSES } from './completeness/expected-responses';
import { watchPage } from './completeness/guards';
import { createThrowaway, SEED_NAMES, seedWorkspace } from './completeness/seed';
import { signUp } from './session';

// The archived contact stays out of the list by design.
const ARCHIVED_NAME = 'Greta Lindqvist';

test('the seeded workspace renders and the page guards stay quiet', async ({ page }) => {
  const watch = watchPage(page, EXPECTED_RESPONSES);
  await signUp(page);
  const seed = await seedWorkspace(page.request);

  await page.goto('/contacts');
  const list = page.getByRole('list', { name: 'Contacts' });
  for (const name of SEED_NAMES.filter((n) => n !== ARCHIVED_NAME)) {
    await expect(list.getByRole('link', { name: new RegExp(name) }).first()).toBeVisible();
  }
  await expect(list.getByRole('link', { name: new RegExp(ARCHIVED_NAME) })).toHaveCount(0);

  await page.goto(`/contacts/${seed.archived}`);
  await expect(page.getByText('This contact is archived.')).toBeVisible();

  await page.goto(`/contacts/${seed.mergedSource}`);
  await expect(page.getByText('This contact was merged into another record.')).toBeVisible();

  await page.goto(`/contacts/${seed.mergeTarget}`);
  await page.getByRole('button', { name: 'Show merge history' }).click();
  await expect(page.getByText(/Merged Dev Okonkwo into this contact/)).toBeVisible();

  await page.goto(`/contacts/${seed.full}`);
  await expect(page.getByText('Wants a quote for 40 m2 of tile.')).toBeVisible();

  // Import history: an imported contact's provenance names the file.
  await page.goto('/contacts');
  await list.getByRole('link', { name: /Imogen Pratt/ }).click();
  await expect(page.getByText(/contacts\.csv/).first()).toBeVisible();

  const throwaway = await createThrowaway(page.request, 'smoke');
  expect(throwaway).toMatch(/^ct_[0-9a-f]{32}$/);

  expect(watch.problems()).toEqual([]);
  watch.stop();
});

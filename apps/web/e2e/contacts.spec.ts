import { expect, type Page, test } from '@playwright/test';
import { addContact, fillContactDialog } from './contact-helpers';
import { signUp } from './session';

/** The list endpoint, with or without a query string (but not /contacts/{id}). */
const CONTACTS_LIST = /\/api\/v1\/contacts(\?.*)?$/;

test('an empty workspace offers to add a contact or import a CSV', async ({ page }) => {
  await signUp(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Contacts' })
    .click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByRole('heading', { name: 'No contacts yet' })).toBeVisible();
  await expect(page.getByText('Add one, or import a CSV.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import CSV' }).first()).toHaveAttribute(
    'href',
    '/contacts/import',
  );
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Contacts' }),
  ).toHaveAttribute('aria-current', 'page');
});

test('create contacts, see them without a reload, reject a duplicate, and search', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');

  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0141', company: 'Okafor & Co' });
  const list = page.getByRole('list', { name: 'Contacts' });
  await expect(list.getByRole('link', { name: /Maya Okafor/ })).toBeVisible();
  await expect(list.getByText('Okafor & Co')).toBeVisible();
  await expect(list.getByText('+1 202 555 0141')).toBeVisible();

  await addContact(page, { name: 'Leo Ortiz', phone: '(202) 555-0142', tags: 'vip, lead' });
  await expect(list.getByRole('link', { name: /Leo Ortiz/ })).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // The same number again: the dialog stays open and explains it next to the field.
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await fillContactDialog(page, { name: 'Maya Again', phone: '+1 202 555 0141' });
  const dialog = page.getByRole('dialog', { name: 'Add contact' });
  await expect(dialog.getByText('A contact with this number already exists.')).toBeVisible();
  await expect(dialog.getByLabel('Phone')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);

  // Search narrows the list (debounced), and clearing it brings everyone back.
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('okafor');
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('link', { name: /Maya Okafor/ })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('zzz-nobody');
  await expect(page.getByText('No contacts match "zzz-nobody".')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search contacts' }).fill('');
  await expect(list.getByRole('listitem')).toHaveCount(2);
});

test('a phone that is not a full number is explained next to the field', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await fillContactDialog(page, { name: 'Bad Number', phone: '12345' });
  const dialog = page.getByRole('dialog', { name: 'Add contact' });
  await expect(
    dialog.getByText('Enter a full number with country code, like +1 202 555 0123.'),
  ).toBeVisible();
});

test('the dialog is keyboard friendly: Escape closes it and focus returns to the button', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  const opener = page.getByRole('button', { name: 'Add contact' }).first();
  await opener.click();
  await expect(page.getByRole('dialog', { name: 'Add contact' }).getByLabel('Name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add contact' })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

/** Two pages of two people each, served from a stub so the spec does not need 50+ contacts. */
async function stubTwoPages(page: Page): Promise<void> {
  const contact = (n: number) => ({
    id: `ct_${n.toString(16).padStart(32, '0')}`,
    organizationId: 'org_x',
    displayName: `Person ${String(n).padStart(2, '0')}`,
    company: null,
    phoneE164: `+12025550${String(100 + n).slice(-3)}`,
    timezone: null,
    source: 'manual',
    email: null,
    jobTitle: null,
    tags: [],
    sourceDetail: null,
    archivedAt: null,
    mergedIntoId: null,
    createdAt: '2026-11-12T10:00:00.000Z',
    updatedAt: '2026-11-12T10:00:00.000Z',
  });
  await page.route(CONTACTS_LIST, (route) => {
    const second = new URL(route.request().url()).searchParams.get('cursor') === 'page-2';
    const items = second ? [contact(3), contact(4)] : [contact(1), contact(2)];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items, nextCursor: second ? null : 'page-2' }, error: null }),
    });
  });
}

test('the Load more button fetches the next page when scrolling is not available', async ({
  page,
}) => {
  // No IntersectionObserver: the button is the only way to load more.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'IntersectionObserver');
  });
  await signUp(page);
  await stubTwoPages(page);
  await page.goto('/contacts');
  const list = page.getByRole('list', { name: 'Contacts' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('reaching the end of the list loads the next page by itself', async ({ page }) => {
  await signUp(page);
  await stubTwoPages(page);
  await page.goto('/contacts');
  const list = page.getByRole('list', { name: 'Contacts' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('a failed load shows an error with a retry', async ({ page }) => {
  await signUp(page);
  let failing = true;
  await page.route(CONTACTS_LIST, (route) =>
    failing
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'x' } }),
        })
      : route.continue(),
  );
  await page.goto('/contacts');
  await expect(page.getByText('We could not load your contacts.')).toBeVisible();
  failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'No contacts yet' })).toBeVisible();
  await expect(page.getByText('Add one, or import a CSV.')).toBeVisible();
});

test('after adding from the empty state, focus goes to the list header, not the page body', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  // The empty state's own button is the second "Add contact"; it disappears once a contact exists.
  await page.getByRole('button', { name: 'Add contact' }).nth(1).click();
  await fillContactDialog(page, { name: 'Focus Person', phone: '+1 202 555 0211' });
  await expect(page.getByRole('dialog', { name: 'Add contact' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add contact' }).first()).toBeFocused();
});

test('the search box follows the address: clearing ?q= from the rail clears the box', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0212' });
  const search = page.getByRole('searchbox', { name: 'Search contacts' });
  await search.fill('maya');
  await expect(page).toHaveURL(/\/contacts\?q=maya$/);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Contacts' })
    .click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(search).toHaveValue('');
});

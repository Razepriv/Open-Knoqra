import { expect, type Page } from '@playwright/test';

export interface NewContact {
  name: string;
  phone: string;
  company?: string;
  email?: string;
  timezone?: string;
  tags?: string;
}

/** Fills and submits the Add contact dialog. Leaves the dialog open so callers can see errors. */
export async function fillContactDialog(page: Page, contact: NewContact): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Add contact' });
  await dialog.getByLabel('Name').fill(contact.name);
  await dialog.getByLabel('Phone').fill(contact.phone);
  if (contact.company) await dialog.getByLabel('Company').fill(contact.company);
  if (contact.email)
    await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill(contact.email);
  if (contact.timezone) await dialog.getByLabel('Time zone').selectOption(contact.timezone);
  if (contact.tags) await dialog.getByLabel('Tags').fill(contact.tags);
  await dialog.getByRole('button', { name: 'Add contact' }).click();
}

export async function addContact(page: Page, contact: NewContact): Promise<void> {
  await page.getByRole('button', { name: 'Add contact' }).first().click();
  await fillContactDialog(page, contact);
  await expect(page.getByRole('dialog', { name: 'Add contact' })).toHaveCount(0);
}

/** Opens a contact from the full list by clicking its row. */
export async function openFromList(page: Page, name: string): Promise<void> {
  await page.goto('/contacts');
  await page
    .getByRole('list', { name: 'Contacts' })
    .getByRole('link', { name: new RegExp(name) })
    .click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

export const timeline = (page: Page) => page.getByRole('region', { name: 'Timeline' });
export const permissions = (page: Page) => page.getByRole('complementary', { name: 'Permissions' });

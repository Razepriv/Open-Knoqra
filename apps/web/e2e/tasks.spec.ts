import { expect, type Page, test } from '@playwright/test';
import { addContact, timeline } from './contact-helpers';
import { signUp } from './session';

const pad = (n: number) => String(n).padStart(2, '0');

/** A `datetime-local` value `days` from now at `hh:mm`, in the machine's own zone. */
function localValue(days: number, hh: number, mm: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hh)}:${pad(mm)}`;
}

async function pickContact(page: Page, name: string): Promise<void> {
  const trigger = page.getByRole('button', { name: /^Contact: / });
  // The trigger's name says what is chosen, not just what the field is.
  await expect(trigger).toHaveAccessibleName('Contact: No contact');
  await trigger.click();
  await page.getByRole('combobox', { name: 'Search contacts' }).fill(name.split(' ')[0] ?? name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await expect(trigger).toHaveAccessibleName(`Contact: ${name}`);
}

async function addTask(
  page: Page,
  title: string,
  options: { due?: string; contact?: string } = {},
): Promise<void> {
  await page.getByLabel('Title').fill(title);
  if (options.due) await page.getByLabel('Due', { exact: true }).fill(options.due);
  if (options.contact) await pickContact(page, options.contact);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('');
}

test('add a task about a contact, complete it, edit another and delete one', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ines Duarte', phone: '+1 202 555 0151' });

  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
  await expect(page.getByText('Nothing due. Add a task, or enjoy the quiet.')).toBeVisible();

  const title = 'Send the onboarding checklist';
  await addTask(page, title, { due: localValue(0, 23, 59), contact: 'Ines Duarte' });

  const today = page.getByRole('region', { name: 'Today' });
  await expect(today.getByText(title)).toBeVisible();
  await expect(today.getByText(/^Today 23:59$/)).toBeVisible();
  await expect(today.getByRole('link', { name: 'Ines Duarte' })).toBeVisible();

  await page.getByRole('checkbox', { name: `Mark ${title} done` }).click();
  await expect(today.getByText(title)).toHaveCount(0);
  await page.getByRole('tab', { name: 'Done' }).click();
  await expect(page.getByText(title)).toBeVisible();

  await page.getByRole('link', { name: 'Ines Duarte' }).click();
  await expect(timeline(page).getByText(`Task done: ${title}`)).toBeVisible();

  // Edit the title of another task.
  await page.goto('/tasks');
  await addTask(page, 'Call the tiler');
  const noDate = page.getByRole('region', { name: 'No date' });
  await expect(noDate.getByText('Call the tiler')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Call the tiler' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit task' });
  await edit.getByLabel('Title').fill('Call the tiler back');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toHaveCount(0);
  await expect(noDate.getByText('Call the tiler back')).toBeVisible();

  // Delete asks first.
  await page.getByRole('button', { name: 'Actions for Call the tiler back' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete task' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(noDate.getByText('Call the tiler back')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Call the tiler back' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page
    .getByRole('dialog', { name: 'Delete task' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByText('Call the tiler back')).toHaveCount(0);
});

test('a past-due task shows under Overdue, and ?new=1 focuses the title', async ({ page }) => {
  await signUp(page);
  await page.goto('/tasks?new=1');
  await expect(page.getByLabel('Title')).toBeFocused();
  await addTask(page, 'Chase the invoice', { due: localValue(-2, 9, 0) });
  const overdue = page.getByRole('region', { name: 'Overdue' });
  await expect(overdue.getByText('Chase the invoice')).toBeVisible();
  await expect(overdue.getByText('Overdue · 2 days')).toBeVisible();
});

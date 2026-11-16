import { expect, type Page, test } from '@playwright/test';
import { addContact, openFromList, timeline } from './contact-helpers';
import { signUp } from './session';

const OTTO_LABEL = 'Otto, the KNOQRA assistant';
const ottoWidget = (page: Page) => page.getByRole('region', { name: 'Otto', exact: true });
const resultCard = (page: Page) => ottoWidget(page).getByRole('article', { name: 'Otto result' });

async function contactWithNote(page: Page, name: string, note: string): Promise<void> {
  await page.goto('/contacts');
  await addContact(page, { name, phone: '+1 202 555 0164' });
  await openFromList(page, name);
  await page.getByLabel('Add a note').fill(note);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText(note)).toBeVisible();
}

async function openToday(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Today' })
    .click();
  await expect(ottoWidget(page)).toBeVisible();
}

async function pickContact(page: Page, name: string): Promise<void> {
  const trigger = ottoWidget(page).getByRole('button', { name: /^Contact for Otto: / });
  await trigger.click();
  await page.getByRole('combobox', { name: 'Search contacts' }).fill(name.split(' ')[0] ?? name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await expect(trigger).toHaveAccessibleName(`Contact for Otto: ${name}`);
}

test('Otto briefs on a contact from its records and cites where each line came from', async ({
  page,
}) => {
  // The longest journey here (sign-up, contact, note, Today, search, brief, back to the contact):
  // about 30 s with four workers sharing one wrangler dev, with no single step stuck (the slowest
  // is the contact search at ~3 s under load). Give it room rather than racing the default.
  test.setTimeout(60_000);
  await signUp(page);
  await contactWithNote(page, 'Marta Quinn', 'Prefers mornings');
  await openToday(page);

  const otto = ottoWidget(page);
  await expect(otto.getByText('OTTO · DRAFTS ONLY · METERED')).toBeVisible();
  await expect(otto.getByText("I'm Otto. What should we do first?")).toBeVisible();
  await expect(otto.getByRole('img', { name: OTTO_LABEL })).toBeVisible();

  await pickContact(page, 'Marta Quinn');
  await otto.getByRole('button', { name: 'Brief me' }).click();

  const card = resultCard(page);
  await expect(card.getByText('BRIEF', { exact: true })).toBeVisible();
  // Screen readers hear the result arrive, and focus is back on the button that asked for it.
  await expect(otto.getByRole('status').filter({ hasText: 'BRIEF ready.' })).toHaveCount(1);
  await expect(otto.getByRole('button', { name: 'Brief me' })).toBeFocused();
  await expect(card.getByText(/Prefers mornings/)).toBeVisible();
  await expect(card.getByText('FROM:')).toBeVisible();
  const source = card.getByRole('link', { name: /Note ·/ });
  await expect(source).toBeVisible();
  await source.click();
  await expect(page).toHaveURL(/\/contacts\/ct_[0-9a-f]{32}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Marta Quinn' })).toBeVisible();
});

test('Otto drafts an SMS that is never sent, and Discard clears it', async ({ page }) => {
  await signUp(page);
  await contactWithNote(page, 'Rafael Lima', 'Asked about the invoice.');
  await openToday(page);
  await pickContact(page, 'Rafael Lima');

  const otto = ottoWidget(page);
  await otto.getByRole('button', { name: 'Draft a reply' }).click();
  const card = resultCard(page);
  await expect(card.getByText('DRAFT · SMS · NOT SENT')).toBeVisible();
  await expect(card.getByText(/Hi Rafael/)).toBeVisible();
  await expect(
    otto.getByRole('status').filter({ hasText: 'DRAFT · SMS · NOT SENT ready.' }),
  ).toHaveCount(1);

  await card.getByRole('button', { name: 'Discard' }).click();
  await expect(resultCard(page)).toHaveCount(0);
  // The announcement is cleared and focus lands on the first action, not on the page body.
  await expect(otto.getByRole('status').filter({ hasText: 'ready.' })).toHaveCount(0);
  await expect(otto.getByRole('button', { name: 'Draft a reply' })).toBeFocused();
});

test("Otto's contact starts as the contact of the first task up next", async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Noor Haddad', phone: '+1 202 555 0188' });
  await page.goto('/tasks');
  await page.getByLabel('Title').fill('Call Noor back');
  await page.getByRole('button', { name: /^Contact: / }).click();
  await page.getByRole('combobox', { name: 'Search contacts' }).fill('Noor');
  await page.getByRole('option', { name: /Noor Haddad/ }).click();
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('');
  await openToday(page);
  await expect(
    ottoWidget(page).getByRole('button', { name: /^Contact for Otto: / }),
  ).toHaveAccessibleName('Contact for Otto: Noor Haddad');
});

test('What did I miss on a fresh account says you are all caught up', async ({ page }) => {
  await signUp(page);
  await expect(ottoWidget(page)).toBeVisible();
  await ottoWidget(page).getByRole('button', { name: 'What did I miss' }).click();
  const card = resultCard(page);
  await expect(card.getByText('WHAT YOU MISSED')).toBeVisible();
  await expect(card.getByText("You're all caught up.")).toBeVisible();
});

test('with reduced motion Otto is a still image with the same name', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signUp(page);
  const head = ottoWidget(page).getByRole('img', { name: OTTO_LABEL });
  await expect(head).toBeVisible();
  await expect(head).toHaveJSProperty('tagName', 'IMG');
  await expect(ottoWidget(page).locator('canvas')).toHaveCount(0);
});

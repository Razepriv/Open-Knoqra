import { expect, test } from '@playwright/test';
import {
  addContact,
  fillContactDialog,
  openFromList,
  permissions,
  timeline,
} from './contact-helpers';
import { signUp } from './session';

test('dialogs opened from menus hand focus back to the control that opened them', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Focus Check', phone: '+1 202 555 0221' });
  await openFromList(page, 'Focus Check');

  const more = page.getByRole('button', { name: 'More actions' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Edit contact' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(more).toBeFocused();

  await more.click();
  await page.getByRole('menuitem', { name: 'Archive contact' }).click();
  await page
    .getByRole('dialog', { name: 'Archive Focus Check?' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(more).toBeFocused();

  const change = page.getByRole('button', { name: 'Change WhatsApp consent' });
  await change.click();
  await page.getByRole('menuitem', { name: 'Grant consent' }).click();
  await expect(page.getByRole('dialog', { name: 'Grant consent: WhatsApp' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(change).toBeFocused();
});

test('cancelling the merge dialog returns focus to the Merge button', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Pia Lund', phone: '+1 202 555 0231' });
  await addContact(page, { name: 'Pia Lund', phone: '+1 202 555 0232' });
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0231/ }).click();
  const merge = permissions(page).getByRole('button', { name: 'Merge Pia Lund' });
  await merge.click();
  await page
    .getByRole('dialog', { name: 'Merge contacts' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(merge).toBeFocused();
  await merge.click();
  await page.keyboard.press('Escape');
  await expect(merge).toBeFocused();
});

test('a duplicate created from the list shows up on a contact opened earlier', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Greta Voss', phone: '+1 202 555 0241' });
  await openFromList(page, 'Greta Voss');
  await expect(permissions(page).getByRole('group', { name: 'Suggested match' })).toHaveCount(0);

  // Add the same name from the narrow list's "+", open the new one, then come back.
  await page.getByRole('button', { name: 'Add contact' }).click();
  await fillContactDialog(page, { name: 'Greta Voss', phone: '+1 202 555 0242' });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const list = page.getByRole('list', { name: 'Contacts' });
  await list.getByRole('link', { name: /0242/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Greta Voss' })).toBeVisible();
  await list.getByRole('link', { name: /0241/ }).click();
  await expect(permissions(page).getByRole('group', { name: 'Suggested match' })).toBeVisible();
});

test('editing a contact is written to its timeline at once', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Log Check', phone: '+1 202 555 0251' });
  await openFromList(page, 'Log Check');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await dialog.getByLabel('Company').fill('Log Co');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(timeline(page).getByText('Contact details updated')).toBeVisible();
});

test('merge history is fetched on request and says when it may be incomplete', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Long History', phone: '+1 202 555 0261' });
  await openFromList(page, 'Long History');
  let scans = 0;
  // Every scan page claims there is more, so the scan hits its cap.
  await page.route(/\/timeline\?.*limit=200/, (route) => {
    scans += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [], nextCursor: `more-${scans}` }, error: null }),
    });
  });
  await page.waitForTimeout(500);
  expect(scans).toBe(0); // nothing is scanned until the block is opened
  await permissions(page).getByRole('button', { name: 'Show merge history' }).click();
  await expect(permissions(page).getByText('Older merges may not be shown.')).toBeVisible();
  // At least the five pages of the cap (development builds may repeat a request).
  expect(scans).toBeGreaterThanOrEqual(5);
});

test('a failed consent refresh keeps the last known state and says so', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Flaky Net', phone: '+1 202 555 0271' });
  await openFromList(page, 'Flaky Net');
  const row = (label: string) => permissions(page).getByRole('listitem').filter({ hasText: label });
  await expect(row('WhatsApp')).toContainText('Blocked');

  let failing = false;
  await page.route(/\/api\/v1\/contacts\/ct_[0-9a-f]+\/permissions$/, (route) =>
    failing && route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ data: null, error: { code: 'internal_error', message: 'x' } }),
        })
      : route.continue(),
  );
  failing = true;
  await page.getByRole('button', { name: 'Change WhatsApp consent' }).click();
  await page.getByRole('menuitem', { name: 'Grant consent' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Grant consent' }).click();
  await expect(permissions(page).getByText(/Couldn.t refresh consent/)).toBeVisible();
  // The rows are still there, and the page did not turn into an error screen.
  await expect(row('WhatsApp')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Flaky Net' })).toBeVisible();
  failing = false;
  await permissions(page).getByRole('button', { name: 'Try again' }).click();
  await expect(row('WhatsApp')).toContainText('Allowed');
  await expect(permissions(page).getByText(/Couldn.t refresh consent/)).toHaveCount(0);
});

test('below 1280px the permissions drawer can change consent and merge', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Drawer Dana', phone: '+1 202 555 0281' });
  await addContact(page, { name: 'Drawer Dana', phone: '+1 202 555 0282' });
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0281/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Drawer Dana' })).toBeVisible();

  await page.getByRole('button', { name: 'Open context' }).click();
  const drawer = page.getByRole('dialog', { name: 'Permissions' });
  await expect(drawer).toBeVisible();

  // A consent dialog opens over the drawer; the drawer stays open underneath.
  await drawer.getByRole('button', { name: 'Change WhatsApp consent' }).click();
  await page.getByRole('menuitem', { name: 'Grant consent' }).click();
  await page
    .getByRole('dialog', { name: 'Grant consent: WhatsApp' })
    .getByRole('button', { name: 'Grant consent' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Grant consent: WhatsApp' })).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('listitem').filter({ hasText: 'WhatsApp' })).toContainText(
    'Allowed',
  );

  // And a merge works from the drawer too.
  await drawer.getByRole('button', { name: 'Merge Drawer Dana' }).click();
  await page
    .getByRole('dialog', { name: 'Merge contacts' })
    .getByRole('button', { name: 'Merge contacts' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Merge contacts' })).toHaveCount(0);
  await expect(drawer.getByRole('group', { name: 'Suggested match' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /Drawer Dana/ }),
  ).toHaveCount(1);
});

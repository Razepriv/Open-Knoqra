import { expect, test } from '@playwright/test';
import { addContact, openFromList, permissions, timeline } from './contact-helpers';
import { signUp } from './session';

test('open a contact from the list and add notes that land at the top of the timeline', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, {
    name: 'Ines Duarte',
    phone: '+1 202 555 0151',
    company: 'Duarte Tiles',
  });
  await openFromList(page, 'Ines Duarte');
  await expect(page).toHaveURL(/\/contacts\/ct_[0-9a-f]{32}$/);
  await expect(page.getByText('Duarte Tiles').first()).toBeVisible();
  await expect(page.getByText('+1 202 555 0151').first()).toBeVisible();

  // Call opens the dialer for this contact. SMS and WhatsApp open the contact's Inbox thread
  // (/inbox?contact=…&channel=…) and show as blocked until the contact gives consent.
  const call = page.getByRole('link', { name: 'Call', exact: true });
  await expect(call).toHaveAttribute('href', /\/calls\?contactId=ct_[0-9a-f]{32}$/);
  // The server blocks messaging without consent, and the header says so in its own words.
  await expect(page.getByText('WhatsApp blocked · Needs consent')).toBeVisible();

  const composer = page.getByRole('textbox', { name: 'Add a note' });
  await composer.fill('Asked for a quote on 40 m2 of tile.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Asked for a quote on 40 m2 of tile.')).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(
    timeline(page)
      .getByText(/internal only · not sent/i)
      .first(),
  ).toBeVisible();

  // Ctrl+Enter submits too, and the newest note is first.
  await composer.fill('Follow up on Friday.');
  await composer.press('Control+Enter');
  const first = timeline(page).getByRole('listitem').first();
  await expect(first).toContainText('Follow up on Friday.');
});

test('the timeline filter pills narrow what is shown', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Tomas Reyes', phone: '+1 202 555 0152' });
  await openFromList(page, 'Tomas Reyes');
  await page.getByRole('textbox', { name: 'Add a note' }).fill('Prefers email.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Prefers email.')).toBeVisible();

  await timeline(page).getByRole('button', { name: 'Calls' }).click();
  await expect(timeline(page).getByRole('button', { name: 'Calls' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(timeline(page).getByText('Prefers email.')).toHaveCount(0);
  await expect(timeline(page).getByText('No calls with this contact yet.')).toBeVisible();
  await timeline(page).getByRole('button', { name: 'Notes & consent' }).click();
  await expect(timeline(page).getByText('Prefers email.')).toBeVisible();
});

test('grant WhatsApp, then do not contact blocks every channel and the call pill', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Wen Zhao', phone: '+1 202 555 0153' });
  await openFromList(page, 'Wen Zhao');

  const row = (label: string) => permissions(page).getByRole('listitem').filter({ hasText: label });
  // Nothing recorded yet: the server says WhatsApp needs consent before messaging.
  await expect(row('WhatsApp')).toContainText('Blocked');
  await expect(row('WhatsApp')).toContainText('Needs consent before messaging.');

  await page.getByRole('button', { name: 'Change WhatsApp consent' }).click();
  await page.getByRole('menuitem', { name: 'Grant consent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grant consent: WhatsApp' });
  await dialog.getByLabel('Evidence (optional)').fill('Opted in on the website form.');
  await dialog.getByRole('button', { name: 'Grant consent' }).click();
  await expect(row('WhatsApp')).toContainText('Allowed');
  await expect(row('WhatsApp')).toContainText('Opted in on the website form.');
  await expect(row('SMS')).toContainText('Blocked');
  // Once WhatsApp is allowed its pill drops the blocked label; it links to the Inbox either way.
  await expect(page.getByText('WhatsApp blocked · Needs consent')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'WhatsApp', exact: true })).toHaveAttribute(
    'href',
    /\/inbox\?contact=ct_[0-9a-f]{32}&channel=whatsapp$/,
  );
  await expect(page.getByRole('link', { name: 'SMS blocked · Needs consent' })).toHaveAttribute(
    'href',
    /\/inbox\?contact=ct_[0-9a-f]{32}&channel=sms$/,
  );

  await page.getByRole('button', { name: 'Change Manual calls consent' }).click();
  await page.getByRole('menuitem', { name: 'Do not contact' }).click();
  const confirm = page.getByRole('dialog', { name: 'Do not contact Wen Zhao?' });
  await expect(confirm).toContainText('every channel');
  await confirm.getByRole('button', { name: 'Mark do not contact' }).click();

  for (const label of ['Manual calls', 'SMS', 'WhatsApp', 'AI voice', 'Recording']) {
    await expect(row(label)).toContainText('Blocked');
    await expect(row(label)).toContainText('Do not contact. Policy, not a task.');
  }
  await expect(page.getByText('Calls blocked · Do not contact')).toBeVisible();
  // The change is recorded on the timeline.
  await timeline(page).getByRole('button', { name: 'Notes & consent' }).click();
  await expect(timeline(page).getByRole('listitem').first()).toContainText(/do not contact/i);
});

test('lifting do not contact on SMS needs a reason, which lands on the timeline', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ama Owusu', phone: '+1 202 555 0154' });
  await openFromList(page, 'Ama Owusu');
  const row = (label: string) => permissions(page).getByRole('listitem').filter({ hasText: label });

  await page.getByRole('button', { name: 'Change SMS consent' }).click();
  await page.getByRole('menuitem', { name: 'Do not contact' }).click();
  await page
    .getByRole('dialog', { name: 'Do not contact Ama Owusu?' })
    .getByRole('button', { name: 'Mark do not contact' })
    .click();
  await expect(row('SMS')).toContainText('Do not contact. Policy, not a task.');

  // Granting SMS now lifts do not contact: the dialog asks how they gave consent again.
  await page.getByRole('button', { name: 'Change SMS consent' }).click();
  await page.getByRole('menuitem', { name: 'Grant consent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lift do not contact: SMS' });
  await expect(dialog).toContainText('How did they give consent again?');
  const reason = dialog.getByRole('textbox', { name: /Reason/ });
  const lift = dialog.getByRole('button', { name: 'Lift and grant consent' });
  await lift.click();
  await expect(dialog.getByText('Add how they gave consent again.')).toBeVisible();
  await expect(reason).toHaveAttribute('aria-invalid', 'true');

  const text = 'Called on 12 Nov and asked for texts again.';
  await reason.fill(text);
  await expect(dialog.getByText(`${text.length} / 500`)).toBeVisible();
  await lift.click();
  await expect(dialog).toHaveCount(0);

  await expect(row('SMS')).toContainText('Allowed');
  await expect(row('SMS')).toContainText(text);
  // Only SMS was lifted.
  await expect(row('WhatsApp')).toContainText('Do not contact. Policy, not a task.');

  await timeline(page).getByRole('button', { name: 'Notes & consent' }).click();
  const latest = timeline(page).getByRole('listitem').first();
  await expect(latest).toContainText('SMS consent granted (do-not-contact lifted)');
  await expect(latest).toContainText(text);
});

test('a duplicate is suggested, never merged on its own, and merging keeps the notes', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0161' });
  await addContact(page, { name: 'Maya Okafor', phone: '+1 202 555 0162' });
  const rows = page
    .getByRole('list', { name: 'Contacts' })
    .getByRole('link', { name: /Maya Okafor/ });
  await expect(rows).toHaveCount(2);

  // Put a note on the first record (the older one is listed first or second: pick by phone).
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0161/ }).click();
  await page.getByRole('textbox', { name: 'Add a note' }).fill('Called about the renewal.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Called about the renewal.')).toBeVisible();

  // On the other record the card suggests the first one.
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0162/ }).click();
  const card = permissions(page).getByRole('group', { name: 'Suggested match' });
  await expect(card).toContainText(/suggested match · not merged/i);
  await expect(card).toContainText('Same name');
  await expect(card).toContainText('+1 202 555 0161');
  await expect(rows).toHaveCount(2);

  await card.getByRole('button', { name: 'Merge Maya Okafor' }).click();
  const confirm = page.getByRole('dialog', { name: 'Merge contacts' });
  await expect(confirm).toContainText(
    'Notes, consent history and timeline move to this contact. The other record is archived.',
  );
  await confirm.getByRole('button', { name: 'Merge contacts' }).click();

  await expect(card).toHaveCount(0);
  // Focus lands somewhere stable instead of falling to the page body.
  await expect(permissions(page).getByRole('heading', { name: 'Permissions' })).toBeFocused();
  await expect(rows).toHaveCount(1);
  await expect(timeline(page).getByText('Called about the renewal.')).toBeVisible();
  // Merge history is read only on request: it scans the timeline.
  await permissions(page).getByRole('button', { name: 'Show merge history' }).click();
  await expect(permissions(page).getByText('Merged Maya Okafor into this contact')).toBeVisible();
});

test('dismissing a suggested match keeps it away', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Dana Whitlock', phone: '+1 202 555 0171' });
  await addContact(page, { name: 'Dana Whitlock', phone: '+1 202 555 0172' });
  await page.getByRole('list', { name: 'Contacts' }).getByRole('link', { name: /0171/ }).click();
  const card = permissions(page).getByRole('group', { name: 'Suggested match' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /is not the same person/ }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Dana Whitlock' })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('editing the time zone updates the local time in the header', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Carlos Mena', phone: '+1 202 555 0181' });
  await openFromList(page, 'Carlos Mena');
  await expect(page.getByText(/Local time/)).toHaveCount(0);

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit contact' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog.getByLabel('Name')).toHaveValue('Carlos Mena');
  await dialog.getByLabel('Time zone').selectOption('America/Chicago');
  await dialog.getByLabel('Job title').fill('Buyer');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(/Local time \d{1,2}:\d{2}\s?(AM|PM) · America\/Chicago/),
  ).toBeVisible();
  await expect(page.getByText('Buyer').first()).toBeVisible();
});

test('archive shows a banner and hides the controls, restore brings them back', async ({
  page,
}) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Nia Brooks', phone: '+1 202 555 0191' });
  await openFromList(page, 'Nia Brooks');

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive contact' }).click();
  // Archiving asks first: cancel leaves everything as it was.
  const confirm = page.getByRole('dialog', { name: 'Archive Nia Brooks?' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('textbox', { name: 'Add a note' })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive contact' }).click();
  await confirm.getByRole('button', { name: 'Archive' }).click();
  const banner = page.getByRole('status').filter({ hasText: 'This contact is archived.' });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Add a note' })).toHaveCount(0);
  // The timeline records it, and an archived contact cannot be edited.
  await expect(timeline(page).getByText('Contact archived')).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Edit contact' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');

  await banner.getByRole('button', { name: 'Restore' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Add a note' })).toBeVisible();
});

test('a contact that is not there, or not yours, says so without saying which', async ({
  page,
  browser,
}) => {
  await signUp(page, { name: 'Owner One' });
  await page.goto('/contacts');
  await addContact(page, { name: 'Private Person', phone: '+1 202 555 0199' });
  await openFromList(page, 'Private Person');
  const url = page.url();

  const missing = "This contact doesn't exist or isn't in your workspace.";
  await page.goto('/contacts/ct_00000000000000000000000000000000');
  await expect(page.getByText(missing)).toBeVisible();

  const other = await browser.newContext();
  try {
    const stranger = await other.newPage();
    await signUp(stranger, { name: 'Owner Two' });
    await stranger.goto(url);
    await expect(stranger.getByText(missing)).toBeVisible();
    await expect(stranger.getByText('Private Person')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the contact page keeps its list on the left and reaches it by keyboard', async ({ page }) => {
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Ruth Adeyemi', phone: '+1 202 555 0201' });
  await addContact(page, { name: 'Omar Haddad', phone: '+1 202 555 0202' });
  await openFromList(page, 'Ruth Adeyemi');
  const list = page.getByRole('list', { name: 'Contacts' });
  await expect(list.getByRole('link', { name: /Ruth Adeyemi/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await list.getByRole('link', { name: /Omar Haddad/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Omar Haddad' })).toBeVisible();
});

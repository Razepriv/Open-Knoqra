import { expect, type Page, test } from '@playwright/test';
import { addContact, openFromList, timeline } from './contact-helpers';
import { signUp } from './session';

const weekGrid = (page: Page) => page.getByRole('region', { name: "This week's conversations" });
const widget = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const goalRing = (page: Page) => widget(page, "Today's focus").getByRole('img', { name: /of/ });

/** The data-widget keys of the widgets on screen, in the order they are shown. */
const widgetOrder = (page: Page) =>
  page
    .locator('[data-widget]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-widget')));

async function addOpenTask(page: Page, title: string): Promise<void> {
  await page.goto('/tasks');
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('');
}

test('a fresh desk shows an empty week, no streak, the goal ring and nothing up next', async ({
  page,
}) => {
  await signUp(page);
  await expect(
    page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Ana/ }),
  ).toBeVisible();
  await expect(page.getByText(/^Today · \w+day, \d{1,2} \w+$/)).toBeVisible();

  const grid = weekGrid(page);
  await expect(grid.getByRole('heading', { name: "This week's conversations" })).toBeVisible();
  await expect(grid.getByText('EVERY CHANNEL, ONE ROW PER PERSON')).toBeVisible();
  await expect(grid.getByText(/^\d{1,2} – \d{1,2} \w+$|^\d{1,2} \w+ – \d{1,2} \w+/)).toBeVisible();
  await expect(grid.getByText('today', { exact: false }).first()).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Add contact' })).toBeVisible();

  const consistency = widget(page, 'Consistency');
  await expect(consistency.getByText('0', { exact: true })).toBeVisible();
  await expect(consistency.getByText('working-day streak')).toBeVisible();
  // A weekend today never counts, so it says so instead (as the heatmap cell below does).
  await expect(
    consistency.getByText(
      /^(Today is open\. One logged outcome keeps it going\.|Weekend\. Your streak picks up on Monday\.)$/,
    ),
  ).toBeVisible();
  await expect(consistency.getByRole('img', { name: /^Today · (pending|weekend)$/ })).toBeVisible();
  await expect(goalRing(page)).toHaveAccessibleName('0 of 6 outcomes today');
  await expect(widget(page, 'Up next').getByText('Nothing up next.')).toBeVisible();
  await expect(widget(page, 'Otto')).toBeVisible();
  // The getting-started ribbon stays.
  await expect(page.getByRole('link', { name: 'Add your first contact' })).toBeVisible();
});

test('a note and a completed task fill the ring, the week grid and today in the heatmap', async ({
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
  await page.getByLabel('Add a note').fill('Asked for the tile samples.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Asked for the tile samples.')).toBeVisible();

  await addOpenTask(page, 'Send the tile samples');
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Today' })
    .click();

  const upNext = widget(page, 'Up next');
  await expect(upNext.getByText('Send the tile samples')).toBeVisible();
  await upNext.getByRole('button', { name: 'Mark Send the tile samples done' }).click();
  await expect(upNext.getByText('Nothing up next.')).toBeVisible();

  await expect(goalRing(page)).toHaveAccessibleName('2 of 6 outcomes today');
  const row = weekGrid(page).getByRole('listitem').filter({ hasText: 'Ines Duarte' });
  await expect(row.getByRole('link', { name: /Ines Duarte/ })).toHaveAttribute(
    'href',
    /\/contacts\/ct_/,
  );
  await expect(row.getByText('Duarte Tiles')).toBeVisible();
  await expect(row.locator('[data-today="true"]').getByText('Note', { exact: true })).toBeVisible();
  // The chip tells a screen reader which day it is on.
  await expect(row.locator('[data-today="true"]').getByText(/^\w{3} \d{1,2} · Note$/)).toHaveCount(
    1,
  );

  const consistency = widget(page, 'Consistency');
  await expect(
    consistency.getByRole('img', { name: /^Today · (kept · )?2 outcomes$/ }),
  ).toBeVisible();
  await expect(widget(page, "Today's focus").getByText('2 outcomes logged')).toBeVisible();
});

test('customizing hides and reorders widgets, survives a reload, and the tray restores them', async ({
  page,
}) => {
  await signUp(page);
  await expect(widget(page, 'Up next')).toBeVisible();
  expect(await widgetOrder(page)).toEqual(['streak', 'next', 'focus', 'otto']);

  await page.getByRole('button', { name: 'Customize' }).click();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Hide Up next' }).click();
  await expect(widget(page, 'Up next')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move Otto earlier' }).click();
  await expect.poll(() => widgetOrder(page)).toEqual(['streak', 'otto', 'focus']);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Move Otto earlier' })).toHaveCount(0);

  await page.reload();
  await expect(widget(page, 'Otto')).toBeVisible();
  await expect.poll(() => widgetOrder(page)).toEqual(['streak', 'otto', 'focus']);
  await expect(widget(page, 'Up next')).toHaveCount(0);

  const tray = page.getByRole('region', { name: 'Hidden widgets' });
  await tray.getByRole('button', { name: 'Show Up next' }).click();
  await expect(widget(page, 'Up next')).toBeVisible();
  await expect(tray).toHaveCount(0);
  await page.reload();
  await expect.poll(() => widgetOrder(page)).toEqual(['streak', 'otto', 'focus', 'next']);
});

test('in Customize mode dragging one widget onto another swaps them', async ({ page }) => {
  await signUp(page);
  await expect(widget(page, 'Up next')).toBeVisible();
  await page.getByRole('button', { name: 'Customize' }).click();
  // The drag events themselves, so the swap does not depend on where the pointer path crosses.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  const source = page.locator('[data-widget="streak"]');
  const target = page.locator('[data-widget="focus"]');
  await source.dispatchEvent('dragstart', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await expect.poll(() => widgetOrder(page)).toEqual(['focus', 'next', 'streak', 'otto']);
  await page.reload();
  await expect.poll(() => widgetOrder(page)).toEqual(['focus', 'next', 'streak', 'otto']);
});

test('keyboard focus stays useful while hiding and moving widgets', async ({ page }) => {
  await signUp(page);
  await expect(widget(page, 'Up next')).toBeVisible();
  await page.getByRole('button', { name: 'Customize' }).click();

  await page.getByRole('button', { name: 'Hide Up next' }).click();
  await expect(page.getByRole('button', { name: "Hide Today's focus" })).toBeFocused();

  // Otto moves to the front: its "earlier" button turns off, so focus goes to "later".
  await page.getByRole('button', { name: 'Move Otto earlier' }).click();
  await expect(page.getByRole('button', { name: 'Move Otto earlier' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => widgetOrder(page)).toEqual(['otto', 'streak', 'focus']);
  await expect(page.getByRole('button', { name: 'Move Otto later' })).toBeFocused();

  for (const label of ['Otto', 'Consistency', "Today's focus"]) {
    await page.getByRole('button', { name: `Hide ${label}` }).click();
  }
  await expect(
    page.getByRole('region', { name: 'Hidden widgets' }).getByRole('button').first(),
  ).toBeFocused();
});

test('the goal stepper changes the daily goal and it is saved', async ({ page }) => {
  await signUp(page);
  await expect(goalRing(page)).toHaveAccessibleName('0 of 6 outcomes today');
  await widget(page, "Today's focus").getByRole('button', { name: 'Raise daily goal' }).click();
  await expect(goalRing(page)).toHaveAccessibleName('0 of 7 outcomes today');
  await expect(widget(page, "Today's focus").getByText('GOAL 7')).toBeVisible();
  await page.reload();
  await expect(goalRing(page)).toHaveAccessibleName('0 of 7 outcomes today');
});

test('a focus block counts down 25 minutes, then says so and resets', async ({ page }) => {
  await page.clock.install();
  await signUp(page);
  const focus = widget(page, "Today's focus");
  const start = focus.getByRole('button', { name: 'Start a 25-minute focus block' });
  await expect(start).toBeVisible();

  // Let the widgets finish loading before time stops (React Query delivers results on a timer).
  await expect(goalRing(page)).toBeVisible();
  await page.clock.pauseAt(Date.now() + 2_000);
  await start.click();
  await expect(focus.getByRole('button', { name: /^Focus block · 25:00 · stop$/ })).toBeVisible();
  // Only start, stop and done are announced, not every tick of the clock.
  await expect(focus.getByRole('button', { name: /^Focus block/ })).not.toHaveAttribute(
    'aria-live',
  );
  await expect(
    focus.getByRole('status').filter({ hasText: 'Focus block started, 25 minutes' }),
  ).toHaveCount(1);
  await page.clock.runFor(1_000);
  await expect(focus.getByRole('button', { name: /^Focus block · 24:59 · stop$/ })).toBeVisible();

  await page.clock.fastForward('25:00');
  await expect(
    page.getByRole('status').filter({ hasText: 'Focus block done. Nice work.' }),
  ).toBeVisible();
  await expect(focus.getByRole('button', { name: 'Start a 25-minute focus block' })).toBeVisible();
});

test('at 800px the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signUp(page);
  await page.goto('/contacts');
  await addContact(page, { name: 'Wide Wanda', phone: '+1 202 555 0177' });
  await openFromList(page, 'Wide Wanda');
  await page.getByLabel('Add a note').fill('Long week.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline(page).getByText('Long week.')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Today' })
    .click();
  await expect(weekGrid(page).getByText('Wide Wanda')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

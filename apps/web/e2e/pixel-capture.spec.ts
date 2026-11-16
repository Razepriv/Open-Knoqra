import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { seedWorkspace } from './completeness/seed';
import { signUp } from './session';

// Run on demand: KNOQRA_PIXEL=1 pnpm exec playwright test pixel-capture --workers=1
// Shoots the Desk at 1440x900 in both themes, to compare with scripts/capture-design.mjs.
test.skip(process.env.KNOQRA_PIXEL !== '1', 'pixel capture runs only with KNOQRA_PIXEL=1');
test.use({ viewport: { width: 1440, height: 900 } });

const OUT = 'test-results/pixel';
const SETTLE_MS = 1500;

const PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'padding',
  'gap',
  'borderRadius',
  'boxShadow',
  'color',
  'backgroundColor',
  'backgroundImage',
  'border',
  'transition',
] as const;

/** Computed style and box of the leaf element whose text is exactly each target, plus its parent. */
async function measure(page: Page, targets: readonly string[]) {
  return page.evaluate(
    ({ targets: wanted, props }) => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      };
      const result: Record<string, unknown> = {};
      for (const text of wanted) {
        const el = [...document.querySelectorAll('*')].find(
          (e) => e.children.length === 0 && e.textContent?.trim() === text,
        );
        if (!el) {
          result[text] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        const entry: Record<string, unknown> = { box: box(el) };
        for (const key of props) entry[key] = cs[key];
        const parent = el.parentElement;
        if (parent) {
          const pcs = getComputedStyle(parent);
          entry.parent = {
            box: box(parent),
            radius: pcs.borderRadius,
            shadow: pcs.boxShadow,
            bg: `${pcs.backgroundColor} ${pcs.backgroundImage.slice(0, 80)}`,
            padding: pcs.padding,
            border: pcs.border,
          };
        }
        result[text] = entry;
      }
      return result;
    },
    { targets, props: PROPS },
  );
}

/** Every large rounded surface (panels, rails, bars, cards): box, radius, shadow, fill, padding. */
async function surfaces(page: Page) {
  return page.evaluate(() => {
    const rows: Record<string, string>[] = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const radius = Number.parseFloat(cs.borderTopLeftRadius);
      if (radius < 14 || r.width * r.height < 3000 || r.width > 1500) continue;
      rows.push({
        box: [r.x, r.y, r.width, r.height].map(Math.round).join(','),
        radius: cs.borderRadius,
        shadow: cs.boxShadow,
        bg: `${cs.backgroundColor} ${cs.backgroundImage.slice(0, 70)}`,
        padding: cs.padding,
        border: cs.border.replace(/ none| solid/g, ''),
        text: (el.textContent ?? '').trim().slice(0, 24),
      });
    }
    return rows;
  });
}

const CONTACT_TARGETS = [
  'Marisol Quintero',
  'Owner · Quintero Tile Works',
  'Contacts',
  'Timeline',
  'Permissions',
  'Manual calls',
  'Allowed',
  'Notes and consent',
  'Call',
  'Today',
];

for (const scheme of ['light', 'dark'] as const) {
  test(`capture the shell and Contact 360 in ${scheme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.addInitScript((theme) => {
      window.localStorage.setItem('knoqra.theme', theme);
    }, scheme);
    await signUp(page, { name: 'Ana Silva' });
    const seed = await seedWorkspace(page.request);

    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${OUT}/app-today-${scheme}.png` });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      `${OUT}/app-today-${scheme}-surfaces.json`,
      JSON.stringify(await surfaces(page), null, 1),
    );

    await page.goto(`/contacts/${seed.full}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Marisol Quintero' })).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${OUT}/app-contact-${scheme}.png` });
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      `${OUT}/app-contact-${scheme}-surfaces.json`,
      JSON.stringify(await surfaces(page), null, 1),
    );
    writeFileSync(
      `${OUT}/app-contact-${scheme}-measure.json`,
      JSON.stringify(await measure(page, CONTACT_TARGETS), null, 1),
    );
  });
}

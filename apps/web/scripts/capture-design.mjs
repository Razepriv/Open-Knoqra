// Renders the Desk v2 design export at 1440x900 in each theme and start view.
// Usage: KNOQRA_DESIGN_DIR=<folder holding desk.html> node scripts/capture-design.mjs
// Output: apps/web/test-results/design/design-{today,contact}-{light,dark}.png
// Needs network: the design loads Google Fonts and lucide from unpkg.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const designDir = process.env.KNOQRA_DESIGN_DIR;
if (!designDir) {
  process.stderr.write('Set KNOQRA_DESIGN_DIR to the folder that holds desk.html.\n');
  process.exit(1);
}
const outDir = fileURLToPath(new URL('../test-results/design/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const file = join(designDir, 'desk.html');
const html = readFileSync(file, 'utf8');
const url = pathToFileURL(file).href;
const SETTLE_MS = 2500;
// The design is a fixed 1440x900 canvas that scales itself down to fit the viewport with margins
// (0.973 at 1440x900), which would shrink every measurement. A viewport at least 1440x900 plus
// margins makes the scale 1, so the canvas is shot 1:1 by clipping to it.
const VIEWPORT = { width: 1600, height: 1000 };
const CANVAS = { width: 1440, height: 900 };

const browser = await chromium.launch();
try {
  for (const theme of ['light', 'dark']) {
    for (const view of ['today', 'contact']) {
      // The design reads its defaults from data-props: patch them in memory, never on disk.
      const patched = html
        .replace(
          '&quot;default&quot;:&quot;light&quot;',
          `&quot;default&quot;:&quot;${theme}&quot;`,
        )
        .replace(
          '&quot;default&quot;:&quot;today&quot;',
          `&quot;default&quot;:&quot;${view}&quot;`,
        );
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.route(url, (route) => route.fulfill({ body: patched, contentType: 'text/html' }));
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      await page.waitForTimeout(SETTLE_MS);
      const clip = await page.evaluate((size) => {
        const canvas = [...document.querySelectorAll('div')].find(
          (el) => el.style.width === `${size.width}px` && el.style.height === `${size.height}px`,
        );
        const rect = canvas?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      }, CANVAS);
      if (!clip || Math.round(clip.width) !== CANVAS.width) {
        throw new Error(`The design canvas is not at scale 1 (${JSON.stringify(clip)})`);
      }
      await page.screenshot({ path: join(outDir, `design-${view}-${theme}.png`), clip });
      process.stdout.write(
        `${view} ${theme} ${errors.length ? errors.slice(0, 2).join(' | ') : 'ok'}\n`,
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}

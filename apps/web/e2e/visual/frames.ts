import { expect, type Locator, type Page } from '@playwright/test';
import { volatileMasks } from './masks';
import { waitForSettled } from './settle';

export const WIDTHS = [1440, 1280, 1024, 768, 390] as const;
export const HEIGHT = 900;
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Frame {
  width: number;
  theme: Theme;
}

/**
 * Every width and theme, or only those named in KNOQRA_VISUAL_FRAMES (for example `1440:light` or
 * `390:dark,1280:light`): a way to prove one screen without shooting all ten frames.
 */
export function selectedFrames(): Frame[] {
  const all = THEMES.flatMap((theme) => WIDTHS.map((width) => ({ width, theme })));
  const only = process.env.KNOQRA_VISUAL_FRAMES?.split(',').map((item) => item.trim());
  if (!only?.length) return all;
  return all.filter((frame) => only.includes(`${frame.width}:${frame.theme}`));
}

/** The clock every visual test freezes: client dates and "Local time" chips stay put. */
export const FROZEN_TIME = new Date('2026-11-12T15:00:00Z');

export async function freezeTime(page: Page): Promise<void> {
  await page.clock.setFixedTime(FROZEN_TIME);
}

export async function setFrame(page: Page, width: number, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.setViewportSize({ width, height: HEIGHT });
}

export interface ShotOptions {
  /** Shoot this element instead of the whole page. */
  target?: (page: Page) => Locator;
  email?: string;
}

/**
 * One baseline per width and theme: `<screen>-<width>-<theme>.png`. The page must already show
 * the screen; each frame waits for it to settle again after the resize.
 */
export async function shootAll(page: Page, screen: string, options: ShotOptions = {}) {
  for (const { width, theme } of selectedFrames()) {
    await setFrame(page, width, theme);
    await waitForSettled(page);
    const name = `${screen}-${width}-${theme}.png`;
    const mask = volatileMasks(page, options.email);
    if (options.target) {
      await expect(options.target(page), name).toHaveScreenshot(name, { mask });
    } else {
      await expect(page, name).toHaveScreenshot(name, { fullPage: true, mask });
    }
  }
}

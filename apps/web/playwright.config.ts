import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { API_ORIGIN, API_PORT, WEB_ORIGIN, WEB_PORT } from './e2e/ports';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// Never adopt a server that is already running: a stale API or Vite would test the wrong code.
// If a port is taken, Playwright fails with "already used". On Windows `wrangler dev` can leave an
// orphaned workerd.exe on 8787 after its parent dies: find it with `netstat -ano | findstr :8787`
// and stop it with `taskkill /PID <pid> /F`.

// Visual baselines are per platform (font rasterisation differs). The `visual` project runs where
// a baseline folder exists for this platform, or when KNOQRA_VISUAL=1 (to generate one). Elsewhere
// it is left out, with a note, so CI on a platform without baselines still passes.
const baselineDir = fileURLToPath(
  new URL(`./e2e/visual/__baselines__/${process.platform}/`, import.meta.url),
);
const includeVisual = existsSync(baselineDir) || process.env.KNOQRA_VISUAL === '1';
if (!includeVisual) {
  const note = `Visual project skipped: no baselines for ${process.platform} (set KNOQRA_VISUAL=1 to generate them).`;
  process.stdout.write(`${note}\n`);
}
// The pixel capture is a tool, not a test: it runs only when asked for.
const includePixel = process.env.KNOQRA_PIXEL === '1';
// The dead-control crawl and the axe scan visit every route in several frames and take most of an
// hour on a CI runner. CI's per-push run leaves them out; the `E2E (full)` workflow runs them with
// KNOQRA_FULL_E2E=1. Locally they always run.
const slowSuites = ['**/crawl.spec.ts', '**/a11y.spec.ts'];
const skipSlowSuites = !!process.env.CI && process.env.KNOQRA_FULL_E2E !== '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts', // *.test.ts here are vitest unit tests
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: !!process.env.CI,
  // One local `wrangler dev` and one Postgres serve every worker. At the default (half the CPU
  // threads) the API answered slower than the 5 s expect timeout and sign-ups timed out.
  workers: 4,
  retries: process.env.CI ? 1 : 0,
  // A shared CI runner answers slower than a dev machine; 5 s expects timed out under load there.
  expect: { timeout: process.env.CI ? 10_000 : 5_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: [
        '**/visual*.spec.ts',
        '**/pixel-capture.spec.ts',
        ...(skipSlowSuites ? slowSuites : []),
      ],
      use: {
        ...devices['Desktop Chrome'],
        // Calls ask for the microphone: grant it and feed a fake device, so no prompt blocks a test.
        permissions: ['microphone'],
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    ...(includeVisual
      ? [
          {
            name: 'visual',
            testMatch: '**/visual*.spec.ts',
            use: {
              ...devices['Desktop Chrome'],
              timezoneId: 'UTC',
              locale: 'en-US',
              reducedMotion: 'reduce' as const,
            },
            snapshotPathTemplate: '{testDir}/visual/__baselines__/{platform}/{arg}{ext}',
            expect: {
              toHaveScreenshot: {
                animations: 'disabled' as const,
                caret: 'hide' as const,
                scale: 'css' as const,
                stylePath: fileURLToPath(new URL('./e2e/visual/screenshot.css', import.meta.url)),
                maxDiffPixelRatio: 0.002,
              },
            },
          },
        ]
      : []),
    ...(includePixel
      ? [
          {
            name: 'pixel',
            testMatch: '**/pixel-capture.spec.ts',
            use: { ...devices['Desktop Chrome'] },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: `pnpm --filter @knoqra/api exec wrangler dev --port ${API_PORT}`,
      cwd: repoRoot,
      url: `${API_ORIGIN}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});

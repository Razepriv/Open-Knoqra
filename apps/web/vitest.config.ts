import { defineConfig } from 'vitest/config';

// Unit tests for pure modules, plus the odd component test (`*.test.tsx`, which opts into jsdom
// with a `@vitest-environment jsdom` comment). Kept apart from vite.config.ts so the router plugin
// does not regenerate the route tree during test runs. UI flows are covered by Playwright (e2e/).
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      // KNOQRA Cloud's Desk code (absent from the open-source tree, where these match nothing).
      'pro/**/*.test.ts',
      'pro/**/*.test.tsx',
      'worker/**/*.test.ts',
      'e2e/**/*.test.ts',
      'scripts/**/*.test.ts',
      '*.test.ts',
    ],
  },
});

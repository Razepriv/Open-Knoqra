import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pro/` (KNOQRA Cloud tables) is absent from the open-source tree; its glob then matches nothing.
    include: ['test/**/*.test.ts', 'pro/test/**/*.test.ts'],
    // All test files share one Postgres database, so they must not run concurrently.
    fileParallelism: false,
    hookTimeout: 60_000,
  },
});

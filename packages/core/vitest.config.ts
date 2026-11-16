import { defineConfig } from 'vitest/config';

// `pro/` holds KNOQRA Cloud code and is absent from the open-source tree; the glob then matches nothing.
export default defineConfig({
  test: { include: ['src/**/*.test.ts', 'pro/**/*.test.ts'] },
});

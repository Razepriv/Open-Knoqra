import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';
import {
  APP_DATABASE_URL,
  MIGRATION_DATABASE_URL,
  UNREACHABLE_DATABASE_URL,
} from './test/database-urls';

/**
 * pg selects its socket with `require('pg-cloudflare')` when it detects workerd. The module
 * fallback service of the Workers test pool resolves that CommonJS require through the root Vite
 * server without the `workerd` export condition, which yields pg-cloudflare's empty Node stub
 * ("CloudflareSocket is not a constructor"). Point it at the real Workers socket implementation.
 * Test-only: wrangler's bundler resolves the `workerd` condition itself for dev and deploys.
 */
const requireFromPg = createRequire(createRequire(import.meta.url).resolve('pg'));
const pgCloudflare = join(
  dirname(requireFromPg.resolve('pg-cloudflare/package.json')),
  'dist/index.js',
);
const pgCloudflareForWorkerd = {
  name: 'knoqra:pg-cloudflare-for-workerd',
  enforce: 'pre' as const,
  resolveId: (id: string) => (id === 'pg-cloudflare' ? pgCloudflare : undefined),
};

const testBindings = {
  APP_ENV: 'test',
  BETTER_AUTH_SECRET: 'test-only-secret-at-least-32-characters-long',
  BETTER_AUTH_URL: 'http://localhost:8787',
  FAKE_WEBHOOK_SECRET: 'test-only-fake-webhook-secret',
  // Test-only, non-secret: 32 bytes of the repeating pattern 0x01..0x20, base64. Never a real key.
  CREDENTIALS_MASTER_KEY: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
  // Tests run without the license screen; license tests set `selfhost` themselves.
  KNOQRA_EDITION: 'cloud',
  // Test-only: lets tests break fixtures the app role may not touch. Worker code never reads it.
  MIGRATION_DATABASE_URL,
};

const workers = (
  databaseUrl: string,
  configPath = './wrangler.jsonc',
  bindings: Record<string, string> = {},
) =>
  cloudflareTest({
    wrangler: { configPath },
    miniflare: { bindings: { ...testBindings, ...bindings, DATABASE_URL: databaseUrl } },
  });

/**
 * KNOQRA Cloud adds `pro/` (its own Worker entry, config and tests). The open-source tree has no
 * such folder, so this project only exists in the private repository. See EDITIONS.md.
 */
const cloudProjects: TestProjectInlineConfiguration[] = [];
// Vite bundles this config into a temp folder but keeps import.meta.url pointing here.
const cloudProjectFile = fileURLToPath(new URL('./pro/vitest.project.ts', import.meta.url));
if (existsSync(cloudProjectFile)) {
  // A variable specifier keeps the open-source typecheck free of this path.
  const pro = (await import(pathToFileURL(cloudProjectFile).href)) as {
    cloudProjects: (
      makeWorkers: typeof workers,
      databaseUrl: string,
    ) => TestProjectInlineConfiguration[];
  };
  cloudProjects.push(...pro.cloudProjects(workers, APP_DATABASE_URL));
}

export default defineConfig({
  // Root level: the pool's module fallback resolves through the root Vite server.
  plugins: [pgCloudflareForWorkerd],
  test: {
    projects: [
      {
        plugins: [workers(APP_DATABASE_URL)],
        test: {
          name: 'api',
          include: ['test/**/*.test.ts'],
          exclude: ['test/health-unreachable.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          // All files share one Postgres database.
          fileParallelism: false,
          // Projects that share the database run one after another (lower groups first).
          sequence: { groupOrder: 0 },
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      ...cloudProjects,
      {
        plugins: [workers(UNREACHABLE_DATABASE_URL)],
        test: {
          name: 'api-db-unreachable',
          include: ['test/health-unreachable.test.ts'],
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

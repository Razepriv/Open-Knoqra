/**
 * Entry point for the Better Auth CLI only: it needs a module exporting a configured `auth`.
 * Regenerate the Drizzle auth tables after changing plugins or auth options in src/auth/auth.ts:
 *
 *   pnpm --filter @knoqra/api auth:generate
 *
 * (output: .wrangler/auth-schema.generated.ts, gitignored), then reconcile
 * packages/db/src/schema/auth.ts with it and add a migration if the tables changed. Never
 * deployed; the connection string is never dialled (the pool connects lazily).
 */
import { createDb } from '@knoqra/db';
import { createAuth } from '../src/auth/auth';
import type { Env } from '../src/env';

const env = {
  APP_ENV: 'development',
  BETTER_AUTH_SECRET: 'cli-schema-generation-only-not-a-secret',
  BETTER_AUTH_URL: 'http://localhost:8787',
  FAKE_WEBHOOK_SECRET: 'cli-schema-generation-only',
  DATABASE_URL: 'postgres://knoqra_app:knoqra_app@localhost:54329/knoqra',
} as Env;

export const auth = createAuth(env, createDb(env.DATABASE_URL as string).db);

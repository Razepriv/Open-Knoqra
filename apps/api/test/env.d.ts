import type { Env as WorkerEnv } from '../src/env';

// Declaration merging: types `env` from cloudflare:workers with the Worker bindings.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Test-only binding (vitest.config.ts): the admin role, for fixture surgery. */
      MIGRATION_DATABASE_URL: string;
    }
  }
}

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './env';
import type { AppEnv } from './lib/context';
import type { CallPricing } from './lib/pricing';

/**
 * A bundle of features mounted on top of the open-source core: the extension point for editions.
 *
 * The core API runs with no extensions. Another edition builds its Worker with
 * `createWorker([extension])` (worker.ts), and each slot below is mounted at a fixed place in the
 * request chain by `createApp` (app.ts). Core code never imports an extension: extensions import
 * core. See EDITIONS.md.
 */
export interface ApiExtension {
  /** A short name, for logs. */
  name: string;
  /** Webhook routes, mounted before the generic `/webhooks/:provider` route (no session). */
  webhooks?: (app: OpenAPIHono<AppEnv>) => void;
  /** Session-free pages, mounted before `/api/auth/*`. */
  publicRoutes?: (app: OpenAPIHono<AppEnv>) => void;
  /** Session routes under `/api/v1/*`, mounted after the tenant check and the license gate. */
  routes?: (app: OpenAPIHono<AppEnv>) => void;
  /** How calls are priced. The first extension that sets one wins; the core prices calls flat. */
  pricing?: CallPricing;
}

/**
 * The env every handler sees: the Worker bindings plus the extensions the Worker was built with.
 * Pricing and other extension hooks are read from it (see lib/pricing.ts), so queue and cron code
 * reach them the same way as routes.
 */
export function withExtensions<E extends Env>(env: E, extensions: readonly ApiExtension[]): E {
  if (env.EXTENSIONS === extensions) return env;
  return { ...env, EXTENSIONS: extensions };
}

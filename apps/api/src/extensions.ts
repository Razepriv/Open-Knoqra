import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Tx } from '@knoqra/db';
import type { CronJob } from './cron/jobs';
import type { NewsletterChange } from './email/newsletter';
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
  /**
   * Scheduled jobs of the edition, run beside the core's (cron/run.ts). Each cron expression must
   * also be in the edition's wrangler config (`triggers.crons`) and must not be a core job's.
   */
  cronJobs?: readonly CronJob[];
  /**
   * The workspace's plan name for the welcome email, read inside that workspace's tenant
   * transaction. The first extension that sets one wins; the core names no plan.
   */
  planName?: (tx: Tx) => Promise<string | null>;
  /**
   * Runs in the background after a user's newsletter choice changes (sign-up, Settings or the
   * unsubscribe link), for example to keep a mailing list in step. Errors are logged, never shown.
   */
  newsletterChanged?: (env: Env, change: NewsletterChange) => Promise<void>;
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

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { CallState } from '@knoqra/core';
import type { Database, Tx } from '@knoqra/db';
import type { CronJob } from './cron/jobs';
import type { NewsletterChange } from './email/newsletter';
import type { Env } from './env';
import type { CallJson } from './lib/call-json';
import type { AppEnv } from './lib/context';
import type { CallPricing } from './lib/pricing';
import type { ProviderAccess } from './lib/provider-access';
import type { OttoPlanAccess } from './otto/access';

/** A verified provider webhook whose event type the core does not model. */
export interface ProviderWebhookDelivery {
  provider: string;
  /** The provider's event type, as it sent it. */
  eventType: string;
  /** The parsed JSON body (its signature already checked). */
  body: unknown;
  /**
   * Set for a per-connection URL: the workspace whose own key verified the delivery, and the only
   * workspace it may change. Null for the platform URL.
   */
  connectorOrgId: string | null;
  /** Runs work after the response (the request's `waitUntil`). */
  waitUntil: (promise: Promise<unknown>) => void;
}

/** A call event that was just applied and committed (events/call-handler.ts). */
export interface AppliedCallEvent {
  orgId: string;
  call: CallJson;
  provider: string;
  /** The provider's id for the call (Telnyx's call control id), when it is known. */
  providerCallId: string | null;
  /** The state change this event made, or null when it changed nothing. */
  transition: { from: CallState; to: CallState } | null;
  /** True when this event ended the call. */
  ended: boolean;
}

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
  /**
   * Session middleware: mounted after the tenant check, the license gate and the core rate limits,
   * before every core session route, so it can refuse a core request for the edition's reasons
   * (for example a per-workspace call cap). `c.var.tenant` and `c.var.db` are set.
   */
  sessionGuards?: (app: OpenAPIHono<AppEnv>) => void;
  /** Session routes under `/api/v1/*`, mounted after the tenant check and the license gate. */
  routes?: (app: OpenAPIHono<AppEnv>) => void;
  /**
   * Adapts a workspace's provider access before any caller uses it (lib/provider-access.ts), inside
   * that workspace's tenant transaction: for example to scope an account the edition shares between
   * workspaces to the numbers this one owns. Each extension that sets one runs in turn.
   */
  providerAccess?: (
    tx: Tx,
    env: Env,
    orgId: string,
    access: ProviderAccess,
    opts: { fetch?: typeof fetch },
  ) => Promise<ProviderAccess>;
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
   * Otto for a workspace that has not connected its own OpenAI key or ChatGPT, read inside the
   * workspace's tenant transaction (otto/access.ts): included with the edition's model, or an
   * upgrade prompt. The first extension that answers wins; `undefined` leaves it to the
   * instance's `AI_PROVIDER`. The core includes nothing.
   */
  ottoPlan?: (tx: Tx, env: Env) => Promise<OttoPlanAccess | undefined>;
  /**
   * Runs in the background after a user's newsletter choice changes (sign-up, Settings or the
   * unsubscribe link), for example to keep a mailing list in step. Errors are logged, never shown.
   */
  newsletterChanged?: (env: Env, change: NewsletterChange) => Promise<void>;
  /**
   * Account deletion, before anything is deleted: a workspace is about to close because its only
   * member deletes their account (account/delete-account.ts). Stop what still bills or renews, for
   * example cancel a subscription. Throwing stops the deletion with nothing changed. Return
   * `keepProviderAccess: true` when the workspace's provider credential must stay so numbers can
   * still be released later.
   */
  beforeWorkspaceClose?: (
    env: Env,
    db: Database,
    orgId: string,
  ) => Promise<{ keepProviderAccess?: boolean } | undefined>;
  /**
   * Account deletion, inside the deletion transaction (tenant context set to `orgId`), before the
   * core removes the workspace's data: the edition removes or anonymises its own tables.
   */
  closeWorkspace?: (tx: Tx, orgId: string) => Promise<void>;
  /**
   * A verified webhook whose event type the core does not model (the core answers 200 and drops
   * it). Return true when the extension handled it; every extension that sets this is asked until
   * one does. Throwing answers 500 so the provider delivers it again, so a handler must be
   * idempotent.
   */
  providerWebhook?: (env: Env, delivery: ProviderWebhookDelivery) => Promise<boolean>;
  /**
   * Runs after a call event is applied and committed, beside the realtime fan-out (provider events
   * and the stale-call sweep), for example to start something when a call is answered. Best
   * effort: an error is logged and swallowed, and the event is not applied again.
   */
  afterCallApplied?: (env: Env, event: AppliedCallEvent) => Promise<void>;
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

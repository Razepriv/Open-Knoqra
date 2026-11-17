import { createApp } from './app';
import { handleScheduled } from './cron/run';
import type { Env } from './env';
import { type ApiExtension, withExtensions } from './extensions';
import { observed } from './observability/sentry';
import { handleProviderEvents } from './queue/consumer';
import { handleDeadLetters, isDeadLetterQueue } from './queue/dead-letter';
import type { QueueMessage } from './queue/messages';

export type { ProviderEventMessage, QueueMessage } from './queue/messages';

/**
 * The Worker handler (HTTP, queues, cron) for an edition: the core with these extensions. Each
 * handler gets the bindings plus the extensions, so queue and cron code price calls the same way
 * as routes. Durable Object classes are exported by the entry module itself (index.ts).
 */
export function createWorker(
  extensions: readonly ApiExtension[] = [],
): ExportedHandler<Env, QueueMessage> {
  const app = createApp(extensions);
  // Sentry wraps these per invocation only when a valid SENTRY_DSN is set (observability/sentry.ts).
  return observed({
    fetch: (request, env, ctx) => app.fetch(request, withExtensions(env, extensions), ctx),
    // One Worker consumes both the provider-events queue (provider events and delayed mid-call
    // meter steps) and its dead-letter queue.
    queue: (batch: MessageBatch<QueueMessage>, env: Env) =>
      isDeadLetterQueue(batch.queue)
        ? handleDeadLetters(batch, withExtensions(env, extensions))
        : handleProviderEvents(batch, withExtensions(env, extensions)),
    // Cron Triggers (wrangler.jsonc `triggers.crons`): each expression runs its job in cron/jobs.ts
    // (stale-call sweep, balance poll, ledger reconcile), recorded in cron_run for the deep health check.
    scheduled: (controller, env, ctx) =>
      handleScheduled(controller, withExtensions(env, extensions), ctx),
  }) satisfies ExportedHandler<Env, QueueMessage>;
}

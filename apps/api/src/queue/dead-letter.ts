import { createDb } from '@knoqra/db';
import { connectionString, type Env } from '../env';
import { markDeadLettered } from '../events/raw-event';
import { configureLogging, logger } from '../lib/logger';
import { reportError } from '../observability/report';

/**
 * Dead-letter queues are named `<queue>-dlq`, with an optional environment suffix
 * (`knoqra-provider-events-dlq-staging`).
 */
export function isDeadLetterQueue(name: string): boolean {
  return /-dlq(?:-[a-z0-9]+)?$/.test(name);
}

/**
 * Marks each exhausted raw event `dead_lettered` and acks it. The rows stay inspectable:
 * `select * from provider_event_raw where status in ('parked', 'dead_lettered')`.
 */
export async function handleDeadLetters(
  batch: MessageBatch<{ rawEventId: string }>,
  env: Env,
): Promise<void> {
  configureLogging({ appEnv: env.APP_ENV });
  const { db, close } = createDb(connectionString(env));
  try {
    for (const msg of batch.messages) {
      try {
        await markDeadLettered(db, msg.body.rawEventId);
        logger.warn('queue.dead_lettered', { rawEventId: msg.body.rawEventId });
        msg.ack();
      } catch (error) {
        logger.error('queue.dead_letter_failed', { rawEventId: msg.body.rawEventId, error });
        reportError(error, { where: 'queue' });
        msg.retry();
      }
    }
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

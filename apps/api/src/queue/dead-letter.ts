import { createDb } from '@knoqra/db';
import { connectionString, type Env } from '../env';
import { markDeadLettered } from '../events/raw-event';
import { configureLogging, logger } from '../lib/logger';
import { reportError } from '../observability/report';
import { rawEventIdOf } from './consumer';
import { isCallMeterMessage, type QueueMessage } from './messages';

/**
 * Dead-letter queues are named `<queue>-dlq`, with an optional environment suffix
 * (`knoqra-provider-events-dlq-staging`).
 */
export function isDeadLetterQueue(name: string): boolean {
  return /-dlq(?:-[a-z0-9]+)?$/.test(name);
}

/**
 * Marks each exhausted raw event `dead_lettered` and acks it. The rows stay inspectable:
 * `select * from provider_event_raw where status in ('parked', 'dead_lettered')`. An exhausted
 * mid-call meter step is logged and reported, then acked: the stale-call sweep's meter backstop
 * extends or cuts that call within five minutes.
 */
export async function handleDeadLetters(
  batch: MessageBatch<QueueMessage>,
  env: Env,
): Promise<void> {
  configureLogging({ appEnv: env.APP_ENV });
  const { db, close } = createDb(connectionString(env));
  try {
    for (const msg of batch.messages) {
      const body: unknown = msg.body;
      if (isCallMeterMessage(body)) {
        logger.error('call_meter.dead_lettered', { callId: body.callId, step: body.step });
        reportError(new Error('call_meter.dead_lettered'), { where: 'queue' });
        msg.ack();
        continue;
      }
      const rawEventId = rawEventIdOf(body);
      if (rawEventId === null) {
        logger.error('queue.unknown_dead_letter', {});
        msg.ack();
        continue;
      }
      try {
        await markDeadLettered(db, rawEventId);
        logger.warn('queue.dead_lettered', { rawEventId });
        msg.ack();
      } catch (error) {
        logger.error('queue.dead_letter_failed', { rawEventId, error });
        reportError(error, { where: 'queue' });
        msg.retry();
      }
    }
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

import { createDb, type Database } from '@knoqra/db';
import { connectionString, type Env } from '../env';
import { claimRawEvent, markIgnored, markParked, rawEventStatus } from '../events/raw-event';
import { dispatch, normalizerFor } from '../events/registry';
import { configureLogging, logger } from '../lib/logger';
import { MessageNotYetKnownError } from '../messaging/ingest';
import { reportError } from '../observability/report';

type Outcome = 'skipped' | 'ignored' | 'parked' | 'processed';

/** A receipt can beat its own send's commit; give the send a moment before the next attempt. */
const NOT_YET_KNOWN_RETRY_SECONDS = 2;

/**
 * One delivery of one raw provider event:
 * 1. claim the row (attempts + 1) while it is pending or parked; a missing or final row is a no-op
 * 2. normalize the stored body; nothing to apply marks it ignored
 * 3. run the handler (calls or messages); parked records the reason, ignored marks the row final
 *    with nothing applied, processed commits with the handler's changes
 * 4. run the handler's best-effort side effects after commit
 */
async function processRawEvent(db: Database, env: Env, rawEventId: string): Promise<Outcome> {
  const raw = await claimRawEvent(db, rawEventId);
  if (!raw) {
    const status = await rawEventStatus(db, rawEventId);
    if (status === undefined) logger.debug('queue.skipped_missing', { rawEventId });
    else logger.debug('queue.skipped_final', { rawEventId, status });
    return 'skipped';
  }
  const event = normalizerFor(raw.provider, env)?.normalize(raw.body) ?? null;
  if (event === null) {
    await markIgnored(db, rawEventId);
    logger.debug('queue.ignored', { rawEventId, provider: raw.provider });
    return 'ignored';
  }
  const result = await dispatch(
    { env, db, rawEventId, connectorOrgId: raw.organizationId ?? null },
    event,
  );
  if (result.status === 'parked') {
    await markParked(db, rawEventId, result.reason);
    logger.info('queue.parked', { rawEventId, provider: raw.provider, reason: result.reason });
    return 'parked';
  }
  if (result.status === 'ignored') {
    await markIgnored(db, rawEventId);
    logger.warn('queue.ignored', { rawEventId, provider: raw.provider, reason: result.reason });
    return 'ignored';
  }
  try {
    await result.after();
  } catch (error) {
    // Already committed: a side-effect failure must not re-run the event.
    logger.error('queue.after_failed', { rawEventId, error });
    reportError(error, { where: 'queue' });
  }
  return 'processed';
}

/**
 * Applies queued provider events. Parked, ignored and replayed messages are acked. A receipt whose
 * message is not yet known retries after a short delay; any other unexpected error retries that
 * message (the queue's max_retries then dead-letters it). Logs carry ids, never the event body.
 */
export async function handleProviderEvents(
  batch: MessageBatch<{ rawEventId: string }>,
  env: Env,
): Promise<void> {
  configureLogging({ appEnv: env.APP_ENV });
  const { db, close } = createDb(connectionString(env));
  try {
    for (const msg of batch.messages) {
      try {
        await processRawEvent(db, env, msg.body.rawEventId);
        msg.ack();
      } catch (error) {
        if (error instanceof MessageNotYetKnownError) {
          // Expected race, not a fault: not sent to Sentry.
          logger.warn('messaging.message_not_yet_known', { rawEventId: msg.body.rawEventId });
          // The send that owns this receipt may not have stored its provider id yet.
          msg.retry({ delaySeconds: NOT_YET_KNOWN_RETRY_SECONDS });
        } else {
          logger.error('queue.process_failed', { rawEventId: msg.body.rawEventId, error });
          reportError(error, { where: 'queue' });
          msg.retry();
        }
      }
    }
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
}

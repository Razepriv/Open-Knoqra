import { type Database, message, withTenant } from '@knoqra/db';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { retryOnConflict } from '../lib/retry';
import { dispatchMessage, loadMessageJson, publishMessage } from './send';
import { recordProviderResult } from './store';

/** A message no worker claimed this long after it was stored is sent by the sweep. */
export const UNCLAIMED_AFTER_MS = 60_000;
/** A claimed message with no provider answer this long after the claim was interrupted. */
export const INTERRUPTED_AFTER_MS = 10 * 60_000;
const BATCH = 50;

/** Never resent blindly: the provider may have accepted it before the worker stopped. */
export const INTERRUPTED_FAILURE = {
  code: 'provider_error',
  message: 'Sending was interrupted. The message may not have been sent.',
  retryable: false,
} as const;

/**
 * One organization's sweep: sends queued messages that no worker claimed (the request's
 * background send never ran), and fails messages whose claimed send never recorded an answer.
 * Returns how many of each it handled.
 */
export async function sweepOrgDispatch(
  db: Database,
  env: Env,
  orgId: string,
  now = new Date(),
): Promise<{ sent: number; interrupted: number }> {
  const unclaimed = await withTenant(db, orgId, (tx) =>
    tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.status, 'queued'),
          isNotNull(message.dispatchPayload),
          isNull(message.dispatchClaimedAt),
          lt(message.createdAt, new Date(now.getTime() - UNCLAIMED_AFTER_MS)),
        ),
      )
      .limit(BATCH),
  );
  let sent = 0;
  for (const { id } of unclaimed) {
    if (await dispatchMessage({ env, orgId, db }, id)) sent += 1;
  }

  const stuck = await withTenant(db, orgId, (tx) =>
    tx
      .select({ id: message.id })
      .from(message)
      .where(
        and(
          eq(message.status, 'queued'),
          isNotNull(message.dispatchPayload),
          lt(message.dispatchClaimedAt, new Date(now.getTime() - INTERRUPTED_AFTER_MS)),
        ),
      )
      .limit(BATCH),
  );
  for (const { id } of stuck) {
    const json = await retryOnConflict(() =>
      withTenant(db, orgId, async (tx) => {
        // Only a message still in that state: a late provider answer wins.
        const [still] = await tx
          .select({ id: message.id })
          .from(message)
          .where(
            and(
              eq(message.id, id),
              eq(message.status, 'queued'),
              sql`${message.dispatchPayload} is not null`,
            ),
          )
          .for('update');
        if (!still) return undefined;
        await recordProviderResult(tx, id, { ok: false, failure: { ...INTERRUPTED_FAILURE } });
        return loadMessageJson(tx, env, id);
      }),
    );
    if (json) await publishMessage(env, orgId, json);
  }
  if (sent > 0 || stuck.length > 0) {
    logger.info('messaging.dispatch_swept', { orgId, sent, interrupted: stuck.length });
  }
  return { sent, interrupted: stuck.length };
}

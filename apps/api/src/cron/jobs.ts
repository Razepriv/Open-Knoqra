import { createDb, type Database, withTenant } from '@knoqra/db';
import { connectionString, type Env } from '../env';
import { runStaleCallSweep } from '../events/stale-calls';
import { publish } from '../lib/realtime';
import { sweepOrgDispatch } from '../messaging/dispatch-sweep';
import { hasTelnyxCredential } from '../messaging/senders';
import { advanceSmsRegistration } from '../messaging/sms-registration';
import { pollOrgBalance } from '../services/balance-poll';
import { completeOrgPendingOrders, syncNumbersAndOrders } from '../services/number-purchase';
import { reconcileOrgDay } from '../services/reconcile';
import { forEachOrganization } from './run';

export interface CronJob {
  /** Stable id: the `cron_run` primary key and the Sentry monitor slug. */
  name: string;
  /** The cron expression exactly as written in wrangler.jsonc `triggers.crons`. */
  cron: string;
  /** The health check reads the job as late once this many minutes pass without a run. */
  maxIntervalMinutes: number;
  run(env: Env, ctx: ExecutionContext): Promise<void>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One organization's balance-poll step: stores a provider balance snapshot, then, only while the
 * organization has a pending number order, syncs its numbers so the order completes (and its
 * number is assigned) once the provider lists the number active.
 */
export async function balancePollOrg(db: Database, env: Env, orgId: string): Promise<void> {
  await pollOrgBalance(db, env, orgId);
  await completeOrgPendingOrders(db, env, orgId);
}

/**
 * Polls every organization's provider balance and finishes pending number orders. `opts` exists
 * for tests; production omits it.
 */
export async function runBalancePoll(
  env: Env,
  opts?: { afterId?: string; now?: Date },
): Promise<void> {
  void opts?.now;
  const handle = createDb(connectionString(env));
  try {
    await forEachOrganization(
      handle.db,
      async (orgId) => {
        await balancePollOrg(handle.db, env, orgId);
      },
      undefined,
      opts?.afterId === undefined ? undefined : { afterId: opts.afterId },
    );
  } finally {
    await handle.close();
  }
}

/** Reconciles the previous UTC day for every organization. `opts` exists for tests. */
export async function runReconcile(
  env: Env,
  opts?: { afterId?: string; now?: Date },
): Promise<void> {
  const now = opts?.now ?? new Date();
  const date = new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
  const handle = createDb(connectionString(env));
  try {
    await forEachOrganization(
      handle.db,
      async (orgId) => {
        await reconcileOrgDay(handle.db, env, { orgId, date, trigger: 'cron', actorUserId: null });
      },
      undefined,
      opts?.afterId === undefined ? undefined : { afterId: opts.afterId },
    );
  } finally {
    await handle.close();
  }
}

export const balancePollJob: CronJob = {
  name: 'balance-poll',
  cron: '*/30 * * * *',
  maxIntervalMinutes: 90,
  async run(env) {
    await runBalancePoll(env);
  },
};

/** Reconciles the previous UTC day of voice usage for every organization. */
export const reconcileJob: CronJob = {
  name: 'ledger-reconcile',
  cron: '15 3 * * *',
  maxIntervalMinutes: 1500,
  async run(env) {
    await runReconcile(env);
  },
};

/** Ends calls whose provider events stopped arriving (ruling R29, events/stale-calls.ts). */
export const staleCallSweepJob: CronJob = {
  name: 'stale-call-sweep',
  cron: '*/5 * * * *',
  maxIntervalMinutes: 5,
  run: (env) => runStaleCallSweep(env),
};

/** Sends messages no worker claimed and fails interrupted sends (messaging/dispatch-sweep.ts). */
export async function runDispatchSweep(env: Env, opts?: { now?: Date }): Promise<void> {
  const handle = createDb(connectionString(env));
  try {
    await forEachOrganization(handle.db, async (orgId) => {
      await sweepOrgDispatch(handle.db, env, orgId, opts?.now);
    });
  } finally {
    await handle.close();
  }
}

/**
 * One organization's messaging status: re-syncs its numbers from its own provider account (10DLC
 * and Meta's WhatsApp approval move the senders), advances an in-flight SMS registration, and
 * tells the Desk. Only for organizations with a Telnyx connection on a Telnyx deployment.
 */
export async function messagingStatusOrg(
  db: Database,
  env: Env,
  orgId: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (env.PROVIDER !== 'telnyx') return;
  const connected = await withTenant(db, orgId, (tx) => hasTelnyxCredential(tx));
  if (!connected) return;
  const deps = fetchImpl ? { fetch: fetchImpl } : {};
  await advanceSmsRegistration(db, env, orgId, deps);
  await syncNumbersAndOrders(db, env, orgId, null, deps);
  await publish(env, orgId, { type: 'channels.updated', data: {} });
}

export async function runMessagingStatus(env: Env): Promise<void> {
  const handle = createDb(connectionString(env));
  try {
    await forEachOrganization(handle.db, async (orgId) => {
      await messagingStatusOrg(handle.db, env, orgId);
    });
  } finally {
    await handle.close();
  }
}

/** Sends what the request's background send never sent; fails sends that never got an answer. */
export const messageDispatchSweepJob: CronJob = {
  name: 'message-dispatch-sweep',
  cron: '*/5 * * * *',
  maxIntervalMinutes: 5,
  run: (env) => runDispatchSweep(env),
};

/** Reads each workspace's SMS and WhatsApp status from its provider and advances registrations. */
export const messagingStatusJob: CronJob = {
  name: 'messaging-status',
  cron: '*/30 * * * *',
  maxIntervalMinutes: 90,
  run: (env) => runMessagingStatus(env),
};

/**
 * Scheduled jobs. Several may share a cron expression: each runs (and is recorded) in turn. A
 * stream that adds an expression adds it to `triggers.crons` in wrangler.jsonc (every env block).
 */
export const CRON_JOBS: readonly CronJob[] = [
  staleCallSweepJob,
  balancePollJob,
  reconcileJob,
  messageDispatchSweepJob,
  messagingStatusJob,
];

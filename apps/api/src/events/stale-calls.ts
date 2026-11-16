import {
  CALL_RESERVE_MINUTES,
  type CallState,
  isTerminal,
  TERMINAL_CALL_STATES,
} from '@knoqra/core';
import { type CallRow, call, callRoute, createDb, type Database, withTenant } from '@knoqra/db';
import type { NormalizedCallEvent } from '@knoqra/providers';
import { and, gt, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { connectionString, type Env } from '../env';
import { logger } from '../lib/logger';
import { type CallBilling, callBillingOf } from '../lib/pricing';
import { reportError } from '../observability/report';
import { type Applied, applyToLockedCall, lockCall } from './call-apply';
import { fanOutApplied } from './call-handler';

/**
 * The stale-call sweep (ruling R29). A call whose provider events stopped arriving (a lost
 * webhook, a browser that closed mid-dial) would otherwise hold its reserve and its user's call
 * lock until the lock's TTL, and stay "live" in every list. A Cron Trigger runs this every five
 * minutes and ends such calls through the same apply path as a provider hangup.
 */

/** call_event.signal of a sweep-ended call. */
export const SWEPT_SIGNAL = 'swept';

const PRE_CONNECT_STATES: readonly CallState[] = ['queued', 'initiating', 'ringing'];
const LIVE_STATES: readonly CallState[] = ['connected', 'ending'];
const PRE_CONNECT_STALE_MS = 10 * 60 * 1000;
const LIVE_STALE_MS = 4 * 60 * 60 * 1000;
/** Only organizations that placed or took a call recently can have a live one. */
const ROUTE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
/** A swept call never bills more than its reserve covered. */
const MAX_SWEPT_SECONDS = CALL_RESERVE_MINUTES * 60;

export interface SweepOptions {
  now?: Date;
  /** Limits the sweep to these organizations instead of discovering them (tests). */
  orgIds?: readonly string[];
}

export interface SweepResult {
  swept: number;
  failed: number;
}

const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

/** Same rule as the query in `staleCallIds`, re-checked under the row lock. */
function isStale(row: CallRow, now: Date): boolean {
  if (PRE_CONNECT_STATES.includes(row.state)) {
    return row.updatedAt < ago(now, PRE_CONNECT_STALE_MS);
  }
  if (LIVE_STATES.includes(row.state)) return row.updatedAt < ago(now, LIVE_STALE_MS);
  return false;
}

/** Organizations with a call route created in the last two days. call_route has no RLS. */
export async function findSweepOrgs(db: Database, now: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: callRoute.organizationId })
    .from(callRoute)
    .where(gt(callRoute.createdAt, ago(now, ROUTE_WINDOW_MS)));
  return rows.map((r) => r.orgId);
}

async function staleCallIds(db: Database, orgId: string, now: Date): Promise<string[]> {
  return withTenant(db, orgId, async (tx) => {
    const rows = await tx
      .select({ id: call.id })
      .from(call)
      .where(
        and(
          notInArray(call.state, [...TERMINAL_CALL_STATES]),
          or(
            and(
              inArray(call.state, [...PRE_CONNECT_STATES]),
              lt(call.updatedAt, ago(now, PRE_CONNECT_STALE_MS)),
            ),
            and(inArray(call.state, [...LIVE_STATES]), lt(call.updatedAt, ago(now, LIVE_STALE_MS))),
          ),
        ),
      )
      .orderBy(sql`${call.updatedAt} asc`);
    return rows.map((r) => r.id);
  });
}

/** Billing (R29): answered_at to the sweep time, capped at the reserve's minutes. */
function sweptSeconds(row: CallRow, now: Date): number | null {
  if (row.answeredAt === null) return null;
  const elapsed = Math.ceil((now.getTime() - row.answeredAt.getTime()) / 1000);
  return Math.min(Math.max(0, elapsed), MAX_SWEPT_SECONDS);
}

/** A provider-shaped hangup for the shared apply path; it is never stored as a raw event. */
function sweepEvent(row: CallRow, now: Date): NormalizedCallEvent {
  return {
    kind: 'call',
    provider: row.provider,
    providerCallId: row.providerCallId ?? '',
    clientState: row.clientState,
    signal: { type: 'hangup', cause: 'failed' },
    direction: row.direction,
    from: row.fromE164,
    to: row.toE164,
    occurredAt: now.toISOString(),
    billableSeconds: sweptSeconds(row, now),
    voicemail: null,
    orgHint: null,
  };
}

/** Ends one call if it is still stale under its row lock. Null when there was nothing to do. */
async function sweepCall(
  db: Database,
  orgId: string,
  callId: string,
  now: Date,
  billing: CallBilling,
): Promise<Extract<Applied, { kind: 'applied' }> | null> {
  const applied = await withTenant(db, orgId, async (tx): Promise<Applied | null> => {
    const row = await lockCall(tx, callId);
    // A provider event may have moved the call on since the scan.
    if (!row || isTerminal(row.state) || !isStale(row, now)) return null;
    const rawEventId = `sweep:${row.id}:${now.getTime()}`;
    return applyToLockedCall(tx, row, rawEventId, sweepEvent(row, now), SWEPT_SIGNAL, billing);
  });
  return applied?.kind === 'applied' ? applied : null;
}

/**
 * Ends every stale call, one transaction per call so a failure skips only that call. Lock
 * release and realtime run after each commit, exactly as for a provider event.
 */
export async function sweepStaleCalls(env: Env, options: SweepOptions = {}): Promise<SweepResult> {
  const now = options.now ?? new Date();
  const { db, close } = createDb(connectionString(env));
  const result: SweepResult = { swept: 0, failed: 0 };
  const billing = callBillingOf(env);
  try {
    const orgIds = options.orgIds ?? (await findSweepOrgs(db, now));
    for (const orgId of orgIds) {
      for (const callId of await staleCallIds(db, orgId, now)) {
        try {
          const applied = await sweepCall(db, orgId, callId, now, billing);
          if (applied === null) continue;
          result.swept += 1;
          logger.info('call.swept', { orgId, callId, state: applied.call.state });
          await fanOutApplied(env, orgId, applied);
        } catch (error) {
          result.failed += 1;
          logger.error('call.sweep_failed', { orgId, callId, error });
          // The sweep moves on, so the cron runner never sees this error.
          reportError(error, { where: 'cron' });
        }
      }
    }
  } finally {
    await close().catch((error: unknown) => logger.warn('db.close_failed', { error }));
  }
  return result;
}

/**
 * The `stale-call-sweep` cron job (cron/jobs.ts, Cron Trigger `*\/5 * * * *`). The cron runner
 * configures logging and records the run in cron_run.
 */
export async function runStaleCallSweep(env: Env): Promise<void> {
  const result = await sweepStaleCalls(env);
  if (result.swept > 0 || result.failed > 0) logger.info('call.sweep_done', { ...result });
}

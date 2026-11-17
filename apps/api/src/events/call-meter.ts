import {
  CALL_EXTEND_LEAD_SECONDS,
  CALL_RESERVE_MINUTES,
  type CallCutoffReason,
  type CallState,
  CUT_OFF_HANGUP_CAUSE,
  cappedBillableSeconds,
  cutoffTime,
  extendCheckAt,
  isTerminal,
  paidUntil,
  type SpendCutoffReason,
  VOICE_RATE_MICROS_PER_MINUTE,
} from '@knoqra/core';
import {
  auditEvent,
  type CallRow,
  call,
  callEvent,
  type Database,
  notification,
  type Tx,
  withTenant,
} from '@knoqra/db';
import { type NormalizedCallEvent, ProviderApiError } from '@knoqra/providers';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { buildProvider, openConnectionSecret } from '../connectors/registry';
import type { Env } from '../env';
import { type CallJson, callJsonById, paidMinutesOf } from '../lib/call-json';
import { logger } from '../lib/logger';
import { workspaceOwnerIds } from '../lib/owners';
import { callBillingOf, platformFeeRate } from '../lib/pricing';
import { publish } from '../lib/realtime';
import { isValidMasterKey } from '../lib/secret-envelope';
import { loadConnection } from '../lib/voice-provider';
import { reportError } from '../observability/report';
import type { CallMeterMessage, CallMeterStep } from '../queue/messages';
import {
  ensureWallet,
  extendCallHold,
  type WalletSummary,
  walletSummary,
} from '../services/ledger';
import { type Applied, applyToLockedCall, lockCall } from './call-apply';
import { fanOutApplied } from './call-handler';
import { scheduleMeterStep } from './call-meter-schedule';

/**
 * Mid-call metering: a call in progress never costs more than the workspace can pay for.
 *
 * A call starts with 10 minutes held (`POST /calls`, or the answer of an inbound call). When it is
 * answered, a meter step is queued for a minute before those minutes run out (call-meter-schedule.ts).
 * The step holds another block from the wallet, within the monthly stop cap, as many whole minutes as
 * fit (up to 10), and queues the next step. When not even one more minute fits, the call gets a
 * cut-off time 10 seconds before its paid time runs out: `call.updated` carries it, so the Desk and the
 * mobile app warn the caller, and a `cutoff` step is queued for then. That step tries once more (credit
 * added during the warning keeps the call going), else hangs the call up at the provider, ends it here
 * through the shared apply path (billed from the answer, never past the paid minutes, every hold closed
 * once), and records an audit row and a notification to each owner.
 *
 * Steps travel on the provider-events queue with a delay: durable, retried and dead-lettered like
 * provider events, and run with the edition's pricing (the Worker's queue handler has the extensions;
 * a Durable Object alarm would not). The stale-call sweep's cron runs `meterLiveCalls` every five
 * minutes as the backstop for a step that was never queued, failed, or was dead-lettered.
 */

/** call_event.signal (and raw event id prefix) of a call KNOQRA ended for lack of credit. */
export const CUT_OFF_SIGNAL = 'cut_off';

/** Calls the provider may still be billing. */
const LIVE_STATES: readonly CallState[] = ['connected', 'ending'];

/** The backstop extends a call this close to its paid time: one cron interval plus the lead. */
const BACKSTOP_LOOKAHEAD_MS = (5 * 60 + CALL_EXTEND_LEAD_SECONDS) * 1000;

/**
 * The backstop cuts a call itself once its queued cut-off is this late, or once it has run this long
 * past its paid minutes with no hold added (it is not extended then: a call whose hangup event was
 * lost would otherwise be extended forever).
 */
const OVERDUE_MS = 60 * 1000;

/** Telnyx's error code for a hang-up of a call that has already ended. */
const CALL_ALREADY_ENDED = '90018';

/** How the cut-off came about: the queued step, or the cron backstop. */
export type CutoffVia = 'timer' | 'backstop';

/** What the provider said to the hang-up. `skipped`: nothing to ask (fake provider, no call id). */
export type CutoffHangup = 'hung_up' | 'already_ended' | 'refused' | 'skipped';

export type MeterOutcome = 'noop' | 'extended' | 'warned' | 'cut_off';

export interface MeterDeps {
  /** For tests: no network in tests. */
  fetch?: typeof fetch;
  now?: Date;
}

interface LiveCall {
  row: CallRow;
  answeredAt: Date;
  paid: number;
}

type Planned = { message: CallMeterMessage; at: Date };

/** A queued step, or the backstop's cut of a call already past its paid minutes. */
type StepMode = CallMeterStep | 'overdue';

type StepResult =
  | { kind: 'noop'; why: 'not_live' | 'stale' | 'cutoff_pending' | 'not_overdue' }
  | { kind: 'extended'; minutes: number; call: CallJson; wallet: WalletSummary; next: Planned }
  | { kind: 'warned'; reason: SpendCutoffReason; call: CallJson; next: Planned }
  | { kind: 'hangup'; reason: CallCutoffReason; row: CallRow };

function liveMetered(row: CallRow | undefined): LiveCall | null {
  if (!row || !LIVE_STATES.includes(row.state) || row.answeredAt === null) return null;
  const paid = paidMinutesOf(row);
  return paid === null ? null : { row, answeredAt: row.answeredAt, paid };
}

const stepMessage = (row: CallRow, step: CallMeterStep, paidMinutes: number): CallMeterMessage => ({
  kind: 'call.meter',
  step,
  orgId: row.organizationId,
  callId: row.id,
  paidMinutes,
});

/** Holds more minutes for the locked live call, or says why it cannot. */
async function tryExtend(
  tx: Tx,
  env: Env,
  live: LiveCall,
): Promise<
  Extract<StepResult, { kind: 'extended' }> | { kind: 'refused'; reason: SpendCutoffReason }
> {
  const { row } = live;
  const perMinuteMicros =
    (row.priceMicrosPerMinute ?? VOICE_RATE_MICROS_PER_MINUTE) + platformFeeRate(env);
  const held = await extendCallHold(tx, {
    orgId: row.organizationId,
    callId: row.id,
    fromPaidMinutes: live.paid,
    perMinuteMicros,
  });
  if (held.kind === 'refused') return held;
  const paid = live.paid + held.minutes;
  await tx
    .update(call)
    .set({ paidMinutes: paid, cutoffReason: null, cutoffAt: null })
    .where(eq(call.id, row.id));
  const walletRow = await ensureWallet(tx, row.organizationId, { starterCredit: false });
  return {
    kind: 'extended',
    minutes: held.minutes,
    call: await callJsonById(tx, row.id),
    wallet: await walletSummary(tx, walletRow, new Date(), callBillingOf(env)),
    next: {
      message: stepMessage(row, 'extend', paid),
      at: extendCheckAt(live.answeredAt, paid),
    },
  };
}

/** Marks the locked live call for a cut-off just before its paid time runs out. */
async function warn(
  tx: Tx,
  live: LiveCall,
  reason: SpendCutoffReason,
  now: Date,
): Promise<Extract<StepResult, { kind: 'warned' }>> {
  const at = cutoffTime(live.answeredAt, live.paid, now);
  await tx
    .update(call)
    .set({ paidMinutes: live.paid, cutoffReason: reason, cutoffAt: at })
    .where(eq(call.id, live.row.id));
  return {
    kind: 'warned',
    reason,
    call: await callJsonById(tx, live.row.id),
    next: { message: stepMessage(live.row, 'cutoff', live.paid), at },
  };
}

/** One step, in one tenant transaction with the call row locked (the lock order of settlement). */
async function decideStep(
  db: Database,
  env: Env,
  message: CallMeterMessage,
  mode: StepMode,
  now: Date,
): Promise<StepResult> {
  return withTenant(db, message.orgId, async (tx): Promise<StepResult> => {
    const live = liveMetered(await lockCall(tx, message.callId));
    if (!live) return { kind: 'noop', why: 'not_live' };
    // Extended since this step was planned (or planned twice): another step owns the call now.
    if (live.paid !== message.paidMinutes) return { kind: 'noop', why: 'stale' };
    if (mode === 'overdue') {
      const over = now.getTime() - paidUntil(live.answeredAt, live.paid).getTime() >= OVERDUE_MS;
      if (!over || live.row.cutoffAt !== null) return { kind: 'noop', why: 'not_overdue' };
      return { kind: 'hangup', reason: 'paid_time_over', row: live.row };
    }
    if (mode === 'extend' && live.row.cutoffAt !== null) {
      return { kind: 'noop', why: 'cutoff_pending' };
    }
    const extended = await tryExtend(tx, env, live);
    if (extended.kind === 'extended') return extended;
    if (mode === 'extend') return warn(tx, live, extended.reason, now);
    return { kind: 'hangup', reason: extended.reason, row: live.row };
  });
}

/**
 * Runs one meter step (a queued message, or the backstop). Throws when the provider hang-up failed
 * in a way worth retrying (network, 5xx, 408, 429), so the queue delivers the step again.
 */
export async function runCallMeter(
  db: Database,
  env: Env,
  message: CallMeterMessage,
  deps: MeterDeps = {},
): Promise<MeterOutcome> {
  return runStep(db, env, message, message.step, 'timer', deps);
}

async function runStep(
  db: Database,
  env: Env,
  message: CallMeterMessage,
  mode: StepMode,
  via: CutoffVia,
  deps: MeterDeps,
): Promise<MeterOutcome> {
  const now = deps.now ?? new Date();
  const result = await decideStep(db, env, message, mode, now);
  switch (result.kind) {
    case 'noop':
      logger.debug('call_meter.noop', { callId: message.callId, why: result.why });
      return 'noop';
    case 'extended':
      logger.info('call_meter.extended', { callId: message.callId, minutes: result.minutes });
      await publish(env, message.orgId, { type: 'call.updated', data: result.call });
      await publish(env, message.orgId, { type: 'wallet.updated', data: result.wallet });
      await scheduleMeterStep(env, result.next.message, result.next.at, now);
      return 'extended';
    case 'warned':
      logger.warn('call_meter.warned', { callId: message.callId, reason: result.reason, via });
      await publish(env, message.orgId, { type: 'call.updated', data: result.call });
      // The backstop found the cut-off time already reached: no time left to queue it.
      if (via === 'backstop' && result.next.at.getTime() <= now.getTime()) {
        return runStep(db, env, result.next.message, 'cutoff', via, deps);
      }
      await scheduleMeterStep(env, result.next.message, result.next.at, now);
      return 'warned';
    case 'hangup':
      await cutOffCall(db, env, result.row, result.reason, via, now, deps);
      return 'cut_off';
  }
}

/**
 * Hangs the call up with the workspace's own provider key (a managed workspace's is the platform
 * key sealed for it). A call that already ended counts as done; a 4xx other than 408 and 429 will not
 * succeed on retry, so it is logged and reported, and the call is ended here anyway; anything else
 * throws so the step is retried.
 */
async function hangUpAtProvider(
  db: Database,
  env: Env,
  row: CallRow,
  deps: MeterDeps,
): Promise<CutoffHangup> {
  if (row.provider === 'fake') return 'skipped';
  const ids = { orgId: row.organizationId, callId: row.id };
  if (row.providerCallId === null) {
    logger.error('call_meter.no_provider_call_id', ids);
    reportError(new Error('call_meter.no_provider_call_id'), { where: 'call_meter' });
    return 'skipped';
  }
  const connection = await withTenant(db, row.organizationId, (tx) => loadConnection(tx));
  if (connection === null || connection.provider !== row.provider) {
    logger.error('call_meter.no_connection', ids);
    reportError(new Error('call_meter.no_connection'), { where: 'call_meter' });
    return 'skipped';
  }
  const masterKey = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKey)) throw new Error('call_meter.no_master_key');
  const secret = await openConnectionSecret(connection, masterKey);
  const built = buildProvider(connection, secret, {
    env,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  try {
    await built.provider.endCall(row.providerCallId);
    return 'hung_up';
  } catch (error) {
    // Plivo refuses a malformed call id before any request: no retry can fix it.
    if (error instanceof RangeError) {
      logger.error('call_meter.hangup_refused', { ...ids, status: 0, code: 'invalid_call_id' });
      reportError(error, { where: 'call_meter' });
      return 'refused';
    }
    if (!(error instanceof ProviderApiError)) throw error;
    const ended =
      error.status === 404 || (error.status === 422 && error.code === CALL_ALREADY_ENDED);
    if (ended) return 'already_ended';
    if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      logger.error('call_meter.hangup_refused', { ...ids, status: error.status, code: error.code });
      reportError(new Error(`call_meter.hangup_refused ${error.status}`), { where: 'call_meter' });
      return 'refused';
    }
    throw error;
  }
}

/** A provider-shaped hangup for the shared apply path; it is never stored as a raw event. */
function cutoffEvent(row: CallRow, now: Date, paidMinutes: number): NormalizedCallEvent {
  return {
    kind: 'call',
    provider: row.provider,
    providerCallId: row.providerCallId ?? '',
    clientState: row.clientState,
    signal: { type: 'hangup', cause: 'normal' },
    direction: row.direction,
    from: row.fromE164,
    to: row.toE164,
    occurredAt: now.toISOString(),
    billableSeconds: cappedBillableSeconds(row.answeredAt, now, paidMinutes),
    voicemail: null,
    orgHint: null,
  };
}

/** Notification copy: no numbers, no amounts. */
export function cutoffNotice(reason: CallCutoffReason): { title: string; body: string } {
  if (reason === 'paid_time_over') {
    return {
      title: 'A call was ended because it ran past the minutes held for it.',
      body: 'KNOQRA could not hold more minutes for the call in time, so it ended the call to keep its cost within what was held.',
    };
  }
  if (reason === 'stop_cap') {
    return {
      title: 'A call was ended because it reached the monthly spend cap.',
      body: 'KNOQRA ends a call when its next minute would pass the monthly stop cap. An owner or admin can raise the cap in the wallet on the Calls page.',
    };
  }
  return {
    title: 'A call was ended because the wallet ran out of credit.',
    body: 'KNOQRA ends a call when the wallet can no longer pay for its next minute. Add credit to keep calls going.',
  };
}

type Recorded = { applied: Extract<Applied, { kind: 'applied' }> | null; call: CallJson };

/**
 * Ends the call here and records the cut-off once, in one tenant transaction with the call row
 * locked. A live call ends through the shared apply path with a synthetic hangup billed from the
 * answer to now, never past its paid minutes; its `call_event` (raw event id `cutoff:<call id>`) is
 * the gate. A call whose own hangup event got here first only gets the gate row. Then the hangup cause
 * becomes `cut_off`, and an audit row and a notification to each owner are written. Null when the
 * cut-off was already recorded.
 */
async function recordCutoff(
  db: Database,
  env: Env,
  callId: string,
  orgId: string,
  reason: CallCutoffReason,
  hangup: CutoffHangup,
  via: CutoffVia,
  now: Date,
): Promise<Recorded | null> {
  return withTenant(db, orgId, async (tx): Promise<Recorded | null> => {
    const row = await lockCall(tx, callId);
    if (!row) return null;
    const rawEventId = `${CUT_OFF_SIGNAL}:${row.id}`;
    const paid = paidMinutesOf(row) ?? CALL_RESERVE_MINUTES;
    let applied: Extract<Applied, { kind: 'applied' }> | null = null;
    if (!isTerminal(row.state)) {
      const result = await applyToLockedCall(
        tx,
        row,
        rawEventId,
        cutoffEvent(row, now, paid),
        CUT_OFF_SIGNAL,
        callBillingOf(env),
      );
      if (result.kind !== 'applied') return null;
      applied = result;
    } else {
      const [gate] = await tx
        .insert(callEvent)
        .values({
          organizationId: orgId,
          callId: row.id,
          rawEventId,
          signal: CUT_OFF_SIGNAL,
          stateBefore: row.state,
          stateAfter: row.state,
          occurredAt: now,
        })
        .onConflictDoNothing({ target: [callEvent.callId, callEvent.rawEventId] })
        .returning({ id: callEvent.id });
      if (!gate) return null;
    }
    await tx
      .update(call)
      .set({
        hangupCause: CUT_OFF_HANGUP_CAUSE,
        cutoffReason: reason,
        cutoffAt: row.cutoffAt ?? now,
      })
      .where(eq(call.id, row.id));
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: null,
      action: 'call.cut_off',
      entityType: 'call',
      entityId: row.id,
      outcome: 'denied',
      // Ids, enums and counts only: never a number.
      metadata: {
        reason,
        paidMinutes: paid,
        hangup,
        via,
        provider: row.provider,
        ...(row.providerCallId === null ? {} : { providerCallId: row.providerCallId }),
      },
    });
    const owners = await workspaceOwnerIds(tx, orgId);
    if (owners.length > 0) {
      const notice = cutoffNotice(reason);
      await tx
        .insert(notification)
        .values(
          owners.map((userId) => ({
            organizationId: orgId,
            userId,
            kind: 'system' as const,
            title: notice.title,
            body: notice.body,
            refType: 'call',
            refId: row.id,
            dedupeKey: `call_cut_off:${row.id}`,
          })),
        )
        .onConflictDoNothing({
          target: [notification.organizationId, notification.userId, notification.dedupeKey],
        });
    }
    const json = await callJsonById(tx, row.id);
    return { applied: applied === null ? null : { ...applied, call: json }, call: json };
  });
}

/** Hangs up at the provider, ends and records the call here, then fans out after commit. */
async function cutOffCall(
  db: Database,
  env: Env,
  row: CallRow,
  reason: CallCutoffReason,
  via: CutoffVia,
  now: Date,
  deps: MeterDeps,
): Promise<void> {
  const orgId = row.organizationId;
  const hangup = await hangUpAtProvider(db, env, row, deps);
  const recorded = await recordCutoff(db, env, row.id, orgId, reason, hangup, via, now);
  logger.warn('call.cut_off', { orgId, callId: row.id, reason, via, hangup, recorded: !!recorded });
  if (recorded === null) return;
  if (recorded.applied) await fanOutApplied(env, orgId, recorded.applied);
  else await publish(env, orgId, { type: 'call.updated', data: recorded.call });
}

export interface MeterBackstopResult {
  checked: number;
  failed: number;
}

/**
 * The backstop (run by the stale-call sweep every five minutes, per organization): a live call
 * within one cron interval of its paid time gets its extension now; a call whose cut-off is more
 * than a minute late, or that has run more than a minute past its paid minutes, is cut here. Steps
 * already done by the queue make these no-ops.
 */
export async function meterLiveCalls(
  db: Database,
  env: Env,
  orgId: string,
  deps: MeterDeps = {},
): Promise<MeterBackstopResult> {
  const now = deps.now ?? new Date();
  const result: MeterBackstopResult = { checked: 0, failed: 0 };
  const live = await withTenant(db, orgId, (tx) =>
    tx
      .select({
        id: call.id,
        answeredAt: call.answeredAt,
        paidMinutes: call.paidMinutes,
        reservationId: call.reservationId,
        cutoffAt: call.cutoffAt,
      })
      .from(call)
      .where(
        and(
          inArray(call.state, [...LIVE_STATES]),
          isNotNull(call.answeredAt),
          isNotNull(call.reservationId),
        ),
      ),
  );
  for (const found of live) {
    const paid = paidMinutesOf(found);
    if (found.answeredAt === null || paid === null) continue;
    const left = paidUntil(found.answeredAt, paid).getTime() - now.getTime();
    let mode: StepMode | null = null;
    if (found.cutoffAt !== null) {
      if (now.getTime() - found.cutoffAt.getTime() >= OVERDUE_MS) mode = 'cutoff';
    } else if (left <= -OVERDUE_MS) {
      mode = 'overdue';
    } else if (left <= BACKSTOP_LOOKAHEAD_MS) {
      mode = 'extend';
    }
    if (mode === null) continue;
    result.checked += 1;
    const step: CallMeterStep = mode === 'extend' ? 'extend' : 'cutoff';
    try {
      const outcome = await runStep(
        db,
        env,
        { kind: 'call.meter', step, orgId, callId: found.id, paidMinutes: paid },
        mode,
        'backstop',
        { ...deps, now },
      );
      if (outcome !== 'noop')
        logger.info('call_meter.backstop', { orgId, callId: found.id, outcome });
    } catch (error) {
      result.failed += 1;
      logger.error('call_meter.backstop_failed', { orgId, callId: found.id, error });
      reportError(error, { where: 'cron' });
    }
  }
  return result;
}

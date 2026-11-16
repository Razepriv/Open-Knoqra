import {
  applyCallSignal,
  type CallState,
  callCostMicros,
  isTerminal,
  VOICE_RATE_MICROS_PER_MINUTE,
} from '@knoqra/core';
import { type CallRow, call, callEvent, callRoute, type Tx, voicemail } from '@knoqra/db';
import type { NormalizedCallEvent } from '@knoqra/providers';
import { and, eq, isNull } from 'drizzle-orm';
import { type CallJson, callJsonById } from '../lib/call-json';
import { logger } from '../lib/logger';
import { type CallBilling, NO_PLATFORM_FEE } from '../lib/pricing';
import {
  callSettleKey,
  chargePlatformFee,
  ensureWallet,
  settleReservation,
  type WalletSummary,
  walletSummary,
} from '../services/ledger';
import { endedCallTitle, insertCallTimeline, voicemailTitle } from './call-timeline';
import { markProcessed } from './raw-event';

/** Provider-supplied text is stored, never trusted for size. */
const MAX_TRANSCRIPT_LENGTH = 4000;

/** call_event.signal of the synthetic answer inferred from a billed hangup (ruling R17). */
export const ANSWERED_INFERRED = 'answered_inferred';

export interface VoicemailJson {
  id: string;
  callId: string;
  contact: CallJson['contact'];
  fromE164: string;
  durationSeconds: number;
  transcript: string | null;
  listenedAt: string | null;
  createdAt: string;
}

export type Applied =
  | { kind: 'parked'; reason: string }
  | { kind: 'replay' }
  | {
      kind: 'applied';
      callId: string;
      userId: string;
      ended: boolean;
      call: CallJson;
      wallet: WalletSummary | null;
      voicemail: VoicemailJson | null;
    };

export const parked = (reason: string): Applied => ({ kind: 'parked', reason });

/**
 * Billing (ruling R7): whole seconds from answered_at to ended_at, rounded up. The provider's own
 * figure is used only when it sent one and the call was answered. A call that never connected
 * bills 0, which releases the hold.
 */
export function billableSecondsOf(
  answeredAt: Date | null,
  endedAt: Date,
  reported: number | null,
): number {
  if (answeredAt === null) return 0;
  if (reported !== null) return reported;
  return Math.max(0, Math.ceil((endedAt.getTime() - answeredAt.getTime()) / 1000));
}

const NOT_YET_CONNECTED: readonly CallState[] = ['queued', 'initiating', 'ringing'];

/**
 * Ruling R17: provider evidence of a connection wins. A hangup that reports billed seconds for a
 * call not yet connected (its answer is late or lost) implies the answer at ended_at − billed.
 * A hangup without a billed figure (Telnyx) infers nothing.
 */
export function inferredAnswerAt(
  state: CallState,
  event: NormalizedCallEvent,
  endedAt: Date,
): Date | null {
  if (event.signal.type !== 'hangup' || !NOT_YET_CONNECTED.includes(state)) return null;
  if (event.billableSeconds === null || event.billableSeconds <= 0) return null;
  return new Date(endedAt.getTime() - event.billableSeconds * 1000);
}

const signalName = (event: NormalizedCallEvent): string =>
  event.signal.type === 'hangup' ? `hangup:${event.signal.cause}` : event.signal.type;

/**
 * Binds the event's provider call id to an unbound call, or says why it cannot: the call is already
 * bound to another id, or the id already routes to a different call.
 */
async function bindOrMismatch(
  tx: Tx,
  row: CallRow,
  providerCallId: string,
): Promise<'ok' | 'call_id_mismatch'> {
  if (row.providerCallId !== null) {
    return row.providerCallId === providerCallId ? 'ok' : 'call_id_mismatch';
  }
  const [owner] = await tx
    .select({ callId: callRoute.callId })
    .from(callRoute)
    .where(and(eq(callRoute.provider, row.provider), eq(callRoute.providerCallId, providerCallId)))
    .limit(1);
  if (owner && owner.callId !== row.id) return 'call_id_mismatch';
  await tx.update(call).set({ providerCallId }).where(eq(call.id, row.id));
  await tx
    .update(callRoute)
    .set({ providerCallId })
    .where(and(eq(callRoute.clientState, row.clientState), isNull(callRoute.providerCallId)));
  return 'ok';
}

/**
 * Applies one call event to a call, inside the tenant transaction, with the call row locked.
 * The call_event insert is the idempotency gate: a conflict means this raw event was already
 * applied, and nothing else changes.
 */
export async function applyToCall(
  tx: Tx,
  rawEventId: string,
  event: NormalizedCallEvent,
  callId: string,
  billing: CallBilling = NO_PLATFORM_FEE,
): Promise<Applied> {
  const row = await lockCall(tx, callId);
  if (!row) return parked('unknown_call');
  if ((await bindOrMismatch(tx, row, event.providerCallId)) !== 'ok') {
    return parked('call_id_mismatch');
  }
  return applyToLockedCall(tx, row, rawEventId, event, signalName(event), billing);
}

/** The call row, locked FOR UPDATE until the tenant transaction ends. */
export async function lockCall(tx: Tx, callId: string): Promise<CallRow | undefined> {
  const [row] = await tx.select().from(call).where(eq(call.id, callId)).limit(1).for('update');
  return row;
}

/**
 * The shared apply path for a call already locked by `lockCall`: provider events and the
 * stale-call sweep both end calls here, so state, call_event, settlement, timeline and the
 * after-commit fan-out match. `signal` is the call_event label.
 */
export async function applyToLockedCall(
  tx: Tx,
  row: CallRow,
  rawEventId: string,
  event: NormalizedCallEvent,
  signal: string,
  billing: CallBilling = NO_PLATFORM_FEE,
): Promise<Applied> {
  const occurredAt = new Date(event.occurredAt);
  const answeredAt = inferredAnswerAt(row.state, event, occurredAt);
  const base: CallRow = answeredAt === null ? row : { ...row, state: 'connected', answeredAt };
  const { next, changed } = applyCallSignal(base.state, event.signal);
  const [logged] = await tx
    .insert(callEvent)
    .values({
      organizationId: row.organizationId,
      callId: row.id,
      rawEventId,
      signal,
      stateBefore: base.state,
      stateAfter: next,
      occurredAt,
    })
    .onConflictDoNothing({ target: [callEvent.callId, callEvent.rawEventId] })
    .returning({ id: callEvent.id });
  if (!logged) {
    await markProcessed(tx, rawEventId);
    return { kind: 'replay' };
  }
  if (answeredAt !== null) {
    await tx.insert(callEvent).values({
      organizationId: row.organizationId,
      callId: row.id,
      rawEventId: `${rawEventId}:${ANSWERED_INFERRED}`,
      signal: ANSWERED_INFERRED,
      stateBefore: row.state,
      stateAfter: 'connected',
      occurredAt: answeredAt,
    });
  }
  if (event.signal.type === 'answered' && isTerminal(row.state)) {
    // Reconciliation (M4) covers any billing this misses.
    logger.warn('call.late_answer', { callId: row.id, rawEventId });
  }
  return applyChanges(tx, rawEventId, event, row, base, { next, changed, occurredAt }, billing);
}

interface Transition {
  next: CallState;
  changed: boolean;
  occurredAt: Date;
}

async function applyChanges(
  tx: Tx,
  rawEventId: string,
  event: NormalizedCallEvent,
  row: CallRow,
  base: CallRow,
  { next, changed, occurredAt }: Transition,
  billing: CallBilling,
): Promise<Applied> {
  const ended = changed && isTerminal(next);
  const ending = ended ? endingOf(base, event, occurredAt) : null;
  if (changed) {
    await tx
      .update(call)
      .set({
        state: next,
        ...(base.answeredAt !== row.answeredAt ? { answeredAt: base.answeredAt } : {}),
        ...(next === 'connected' ? { answeredAt: occurredAt } : {}),
        ...(ending ?? {}),
      })
      .where(eq(call.id, row.id));
  }
  const settled = ending !== null && row.reservationId !== null;
  if (settled) {
    await settle(tx, row, row.reservationId as string, ending.costMicros);
    // The terminal transition happens once per call (under the row lock), and the fee's key
    // makes a second charge impossible anyway.
    await chargePlatformFee(tx, {
      orgId: row.organizationId,
      callId: row.id,
      billableSeconds: ending.billableSeconds,
      ratePerMinute: billing.platformFeeMicrosPerMinute,
    });
  }
  const isVoicemail = event.voicemail !== null && row.direction === 'inbound';
  if (ending !== null && row.contactId !== null && !isVoicemail) {
    const title = endedCallTitle({
      direction: row.direction,
      state: next,
      answered: base.answeredAt !== null,
      billableSeconds: ending.billableSeconds,
    });
    await insertCallTimeline(tx, row, row.contactId, title, occurredAt);
  }
  const vm =
    isVoicemail && event.voicemail
      ? await insertVoicemail(tx, row, event.voicemail, occurredAt)
      : null;
  await markProcessed(tx, rawEventId);

  const callJson = await callJsonById(tx, row.id);
  const wallet = settled
    ? await walletSummary(
        tx,
        await ensureWallet(tx, row.organizationId, { starterCredit: false }),
        new Date(),
        billing,
      )
    : null;
  return {
    kind: 'applied',
    callId: row.id,
    userId: row.userId,
    ended,
    call: callJson,
    wallet,
    voicemail: vm === null ? null : { ...vm, contact: callJson.contact },
  };
}

/**
 * The call's end: billed per started minute at the price fixed when it was authorized (the flat
 * voice rate for calls without one), and the provider's estimated cost for reconciliation.
 */
function endingOf(base: CallRow, event: NormalizedCallEvent, endedAt: Date) {
  const billableSeconds = billableSecondsOf(base.answeredAt, endedAt, event.billableSeconds);
  const providerRate = base.providerCostMicrosPerMinute;
  return {
    endedAt,
    hangupCause: event.signal.type === 'hangup' ? event.signal.cause : null,
    billableSeconds,
    costMicros: callCostMicros(
      billableSeconds,
      base.priceMicrosPerMinute ?? VOICE_RATE_MICROS_PER_MINUTE,
    ),
    providerCostMicros:
      providerRate === null ? null : callCostMicros(billableSeconds, providerRate),
  };
}

/**
 * Settles the call's hold once (callSettleKey). If the reservation was already closed another
 * way, the ledger returns that close unchanged; the mismatch is logged (ids and kinds only) and
 * processing continues.
 */
async function settle(
  tx: Tx,
  row: CallRow,
  reservationId: string,
  costMicros: number,
): Promise<void> {
  const entry = await settleReservation(tx, {
    orgId: row.organizationId,
    reservationId,
    costMicros,
    idempotencyKey: callSettleKey(row.id),
    refType: 'call',
    refId: row.id,
  });
  const expectedKind = costMicros === 0 ? 'release' : 'capture';
  const sameAmount = expectedKind === 'release' || entry.balanceDeltaMicros === -costMicros;
  if (entry.kind !== expectedKind || !sameAmount) {
    logger.warn('ledger.settle_mismatch', {
      callId: row.id,
      reservationId,
      entryId: entry.id,
      expectedKind,
      actualKind: entry.kind,
    });
  }
}

async function insertVoicemail(
  tx: Tx,
  row: CallRow,
  vm: NonNullable<NormalizedCallEvent['voicemail']>,
  occurredAt: Date,
): Promise<Omit<VoicemailJson, 'contact'> | null> {
  const transcript = vm.transcript === null ? null : vm.transcript.slice(0, MAX_TRANSCRIPT_LENGTH);
  const [created] = await tx
    .insert(voicemail)
    .values({
      organizationId: row.organizationId,
      callId: row.id,
      contactId: row.contactId,
      fromE164: row.fromE164,
      durationSeconds: vm.durationSeconds,
      transcript,
    })
    .onConflictDoNothing({ target: voicemail.callId })
    .returning();
  if (!created) return null;
  if (row.contactId !== null) {
    const title = voicemailTitle(vm.durationSeconds);
    await insertCallTimeline(tx, row, row.contactId, title, occurredAt);
  }
  return {
    id: created.id,
    callId: created.callId,
    fromE164: created.fromE164,
    durationSeconds: created.durationSeconds,
    transcript: created.transcript,
    listenedAt: null,
    createdAt: created.createdAt.toISOString(),
  };
}

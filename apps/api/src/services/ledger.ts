import {
  callReserveMicros,
  evaluateSpend,
  planCallExtension,
  planCapture,
  planRelease,
  planReserve,
  platformFeeMicros,
  type SpendCutoffReason,
  type SpendDecision,
} from '@knoqra/core';
import { type LedgerEntryRow, ledgerEntry, type Tx, type WalletRow, wallet } from '@knoqra/db';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';

/** Development and test organizations start with $5 so the fake provider can place calls. */
export const STARTER_CREDIT_MICROS = 5_000_000;
export const STARTER_CREDIT_KEY = 'starter-credit';

/**
 * The one idempotency key that closes a call's hold. The app-side cancel and the provider event
 * pipeline both use it, so a call is settled at most once whichever path gets there first.
 */
export const callSettleKey = (callId: string): string => `call:${callId}:settle`;

/**
 * The key of a hold added mid-call, named by the paid minutes the call had before it: each block is
 * held at most once, however often the meter runs.
 */
export const callExtendKey = (callId: string, fromPaidMinutes: number): string =>
  `call:${callId}:extend:${fromPaidMinutes}`;

/** The one idempotency key of a call's platform fee: a call is charged the fee at most once. */
export const callFeeKey = (callId: string): string => `call:${callId}:fee`;
const STARTER_CREDIT_NOTE = 'Development starter credit';

export interface WalletSummary {
  currency: 'USD';
  balanceMicros: number;
  heldMicros: number;
  availableMicros: number;
  periodSpendMicros: number;
  warnCapMicros: number | null;
  stopCapMicros: number | null;
  /** The wallet as it stands (no new spend requested). */
  status: SpendDecision;
  /** Whether the next call's reserve would be allowed: what the dialer should follow. */
  dialStatus: SpendDecision;
}

export type LedgerErrorCode =
  | 'wallet_missing'
  | 'not_a_reservation'
  | 'idempotency_conflict'
  | 'invalid_amount';

/** A ledger call the service refuses: a programming or data error, never a spend decision. */
export class LedgerError extends Error {
  constructor(readonly code: LedgerErrorCode) {
    super(`Ledger refused the operation: ${code}`);
    this.name = 'LedgerError';
  }
}

function assertMicros(value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) throw new LedgerError('invalid_amount');
}

/** Postgres sums come back as text; money must stay an exact integer. */
function toMicros(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new RangeError('ledger sum is not a safe integer');
  return n;
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function walletOf(tx: Tx, orgId: string, lock: boolean): Promise<WalletRow> {
  const query = tx.select().from(wallet).where(eq(wallet.organizationId, orgId)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new LedgerError('wallet_missing');
  return row;
}

async function entryByKey(
  tx: Tx,
  orgId: string,
  idempotencyKey: string,
): Promise<LedgerEntryRow | undefined> {
  const [row] = await tx
    .select()
    .from(ledgerEntry)
    .where(
      and(eq(ledgerEntry.organizationId, orgId), eq(ledgerEntry.idempotencyKey, idempotencyKey)),
    )
    .limit(1);
  return row;
}

/** Creates the organization's wallet if absent; optionally grants the one-time starter credit. */
export async function ensureWallet(
  tx: Tx,
  orgId: string,
  opts: { starterCredit: boolean },
): Promise<WalletRow> {
  await tx.insert(wallet).values({ organizationId: orgId }).onConflictDoNothing();
  const row = await walletOf(tx, orgId, false);
  if (opts.starterCredit) {
    // The idempotency key makes this a no-op after the first grant, even under concurrency.
    await tx
      .insert(ledgerEntry)
      .values({
        organizationId: orgId,
        walletId: row.id,
        kind: 'credit',
        balanceDeltaMicros: STARTER_CREDIT_MICROS,
        heldDeltaMicros: 0,
        idempotencyKey: STARTER_CREDIT_KEY,
        note: STARTER_CREDIT_NOTE,
      })
      .onConflictDoNothing();
  }
  return row;
}

interface Totals {
  balanceMicros: number;
  heldMicros: number;
  periodSpendMicros: number;
}

async function totals(tx: Tx, walletRow: WalletRow, now: Date): Promise<Totals> {
  const since = monthStartUtc(now).toISOString();
  const [row] = await tx
    .select({
      balance: sql<string>`coalesce(sum(${ledgerEntry.balanceDeltaMicros}), 0)::text`,
      held: sql<string>`coalesce(sum(${ledgerEntry.heldDeltaMicros}), 0)::text`,
      // Spend is what the caps limit: provider charges (captures) and KNOQRA's platform fees.
      spend: sql<string>`coalesce(-sum(${ledgerEntry.balanceDeltaMicros}) filter (where ${ledgerEntry.kind} in ('capture', 'fee') and ${ledgerEntry.createdAt} >= ${since}::timestamptz), 0)::text`,
    })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, walletRow.organizationId),
        eq(ledgerEntry.walletId, walletRow.id),
      ),
    );
  return {
    balanceMicros: toMicros(row?.balance),
    heldMicros: toMicros(row?.held),
    periodSpendMicros: toMicros(row?.spend),
  };
}

function decide(walletRow: WalletRow, t: Totals, requestMicros: number): SpendDecision {
  return evaluateSpend({
    availableMicros: t.balanceMicros - t.heldMicros,
    periodSpendMicros: t.periodSpendMicros,
    heldMicros: t.heldMicros,
    requestMicros,
    warnCapMicros: walletRow.warnCapMicros,
    stopCapMicros: walletRow.stopCapMicros,
  });
}

export async function walletSummary(
  tx: Tx,
  walletRow: WalletRow,
  now: Date,
  opts: { platformFeeMicrosPerMinute?: number } = {},
): Promise<WalletSummary> {
  const t = await totals(tx, walletRow, now);
  const availableMicros = t.balanceMicros - t.heldMicros;
  const status: SpendDecision =
    availableMicros <= 0
      ? { outcome: 'stop', reason: 'insufficient_funds' }
      : decide(walletRow, t, 0);
  return {
    currency: 'USD',
    balanceMicros: t.balanceMicros,
    heldMicros: t.heldMicros,
    availableMicros,
    periodSpendMicros: t.periodSpendMicros,
    warnCapMicros: walletRow.warnCapMicros,
    stopCapMicros: walletRow.stopCapMicros,
    status,
    dialStatus: decide(walletRow, t, callReserveMicros(opts.platformFeeMicrosPerMinute ?? 0)),
  };
}

export interface ReserveInput {
  orgId: string;
  amountMicros: number;
  idempotencyKey: string;
  refType: string;
  refId: string;
  actorUserId: string | null;
}

export type ReserveResult =
  | { entry: LedgerEntryRow; decision: SpendDecision }
  | { refused: SpendDecision };

/**
 * Holds `amountMicros`. The wallet row lock (FOR UPDATE) serializes every reserve and settlement
 * of the organization, so the spend check and the insert see one consistent balance.
 */
export async function reserve(tx: Tx, input: ReserveInput): Promise<ReserveResult> {
  assertMicros(input.amountMicros, 1);
  const walletRow = await walletOf(tx, input.orgId, true);
  const existing = await entryByKey(tx, input.orgId, input.idempotencyKey);
  if (existing) {
    if (existing.kind !== 'reserve' || existing.walletId !== walletRow.id) {
      throw new LedgerError('idempotency_conflict');
    }
    // The hold is already counted in `held`, so the request is 0.
    return {
      entry: existing,
      decision: decide(walletRow, await totals(tx, walletRow, new Date()), 0),
    };
  }
  const decision = decide(walletRow, await totals(tx, walletRow, new Date()), input.amountMicros);
  if (decision.outcome === 'stop') return { refused: decision };
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      kind: 'reserve',
      ...planReserve(input.amountMicros),
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      actorUserId: input.actorUserId,
    })
    .returning();
  if (!entry) throw new Error('reserve insert returned no row');
  return { entry, decision };
}

export interface SettleInput {
  orgId: string;
  reservationId: string;
  costMicros: number;
  idempotencyKey: string;
  refType: string;
  refId: string;
}

async function settlementOf(
  tx: Tx,
  orgId: string,
  reservationId: string,
): Promise<LedgerEntryRow | undefined> {
  const [row] = await tx
    .select()
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, orgId),
        eq(ledgerEntry.reservationId, reservationId),
        inArray(ledgerEntry.kind, ['capture', 'release']),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Closes a reservation: cost 0 is a `release`, anything else a `capture` (which may exceed the
 * hold, taking the balance below zero). Idempotent: a reservation is settled at most once, and a
 * second settlement (by key, sequentially or concurrently) returns the first one.
 */
export async function settleReservation(tx: Tx, input: SettleInput): Promise<LedgerEntryRow> {
  assertMicros(input.costMicros, 0);
  const walletRow = await walletOf(tx, input.orgId, true);
  const byKey = await entryByKey(tx, input.orgId, input.idempotencyKey);
  if (byKey) {
    if (byKey.reservationId !== input.reservationId || byKey.kind === 'reserve') {
      throw new LedgerError('idempotency_conflict');
    }
    return byKey;
  }
  const [hold] = await tx
    .select()
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, input.orgId),
        eq(ledgerEntry.walletId, walletRow.id),
        eq(ledgerEntry.id, input.reservationId),
        eq(ledgerEntry.kind, 'reserve'),
      ),
    )
    .limit(1);
  if (!hold) throw new LedgerError('not_a_reservation');
  const prior = await settlementOf(tx, input.orgId, hold.id);
  if (prior) return prior;
  const plan =
    input.costMicros === 0
      ? { kind: 'release' as const, ...planRelease(hold.heldDeltaMicros) }
      : { kind: 'capture' as const, ...planCapture(hold.heldDeltaMicros, input.costMicros) };
  // DO NOTHING covers both unique keys (idempotency key, one close per reservation) without
  // aborting the transaction; the wallet lock makes a conflict here unlikely in the first place.
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      ...plan,
      reservationId: hold.id,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();
  if (entry) return entry;
  const winner =
    (await settlementOf(tx, input.orgId, hold.id)) ??
    (await entryByKey(tx, input.orgId, input.idempotencyKey));
  if (!winner || winner.reservationId !== hold.id) throw new LedgerError('idempotency_conflict');
  return winner;
}

export interface CreditInput {
  orgId: string;
  amountMicros: number;
  note: string;
  idempotencyKey: string;
  actorUserId: string | null;
  /** What the money came from, for example a payment's type and its id. */
  refType?: string;
  refId?: string;
}

/** Records money added to the wallet. Replaying the key returns the first entry (`created: false`). */
export async function credit(
  tx: Tx,
  input: CreditInput,
): Promise<{ entry: LedgerEntryRow; created: boolean }> {
  assertMicros(input.amountMicros, 1);
  const walletRow = await walletOf(tx, input.orgId, true);
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      kind: 'credit',
      balanceDeltaMicros: input.amountMicros,
      heldDeltaMicros: 0,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      actorUserId: input.actorUserId,
    })
    .onConflictDoNothing()
    .returning();
  if (entry) return { entry, created: true };
  const existing = await entryByKey(tx, input.orgId, input.idempotencyKey);
  const sameCredit =
    existing?.kind === 'credit' && existing.balanceDeltaMicros === input.amountMicros;
  if (!existing || !sameCredit) throw new LedgerError('idempotency_conflict');
  return { entry: existing, created: false };
}

export interface AdjustInput {
  orgId: string;
  /** Non-zero safe integer: negative takes money out of the balance, positive puts it back. */
  balanceDeltaMicros: number;
  note: string;
  idempotencyKey: string;
  refType: string;
  refId: string;
  actorUserId: string | null;
}

/**
 * Corrects the balance by a signed amount (held is untouched). Replaying the key with the same
 * delta returns the first entry (`created: false`); any other use of the key is a conflict.
 */
export async function adjust(
  tx: Tx,
  input: AdjustInput,
): Promise<{ entry: LedgerEntryRow; created: boolean }> {
  if (!Number.isSafeInteger(input.balanceDeltaMicros) || input.balanceDeltaMicros === 0) {
    throw new LedgerError('invalid_amount');
  }
  const walletRow = await walletOf(tx, input.orgId, true);
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      kind: 'adjust',
      balanceDeltaMicros: input.balanceDeltaMicros,
      heldDeltaMicros: 0,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      note: input.note,
      actorUserId: input.actorUserId,
    })
    .onConflictDoNothing()
    .returning();
  if (entry) return { entry, created: true };
  const existing = await entryByKey(tx, input.orgId, input.idempotencyKey);
  const same =
    existing?.kind === 'adjust' && existing.balanceDeltaMicros === input.balanceDeltaMicros;
  if (!existing || !same) throw new LedgerError('idempotency_conflict');
  return { entry: existing, created: false };
}

export interface PlatformFeeInput {
  orgId: string;
  callId: string;
  billableSeconds: number;
  ratePerMinute: number;
}

/**
 * Charges KNOQRA's platform fee for a call: every billed minute at the rate, as one `fee` entry
 * (a plain debit outside the call's reservation). Nothing is written for 0 seconds or a 0 rate. The
 * call's key makes it once per call: a replay returns the first entry, even at another rate.
 */
export async function chargePlatformFee(
  tx: Tx,
  input: PlatformFeeInput,
): Promise<LedgerEntryRow | null> {
  const amount = platformFeeMicros(input.billableSeconds, input.ratePerMinute);
  if (amount === 0) return null;
  const walletRow = await walletOf(tx, input.orgId, true);
  const minutes = Math.ceil(input.billableSeconds / 60);
  const key = callFeeKey(input.callId);
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      kind: 'fee',
      balanceDeltaMicros: -amount,
      heldDeltaMicros: 0,
      refType: 'call',
      refId: input.callId,
      idempotencyKey: key,
      note: `Platform fee, ${minutes} min`,
    })
    .onConflictDoNothing()
    .returning();
  if (entry) return entry;
  const existing = await entryByKey(tx, input.orgId, key);
  if (existing?.kind !== 'fee') throw new LedgerError('idempotency_conflict');
  return existing;
}

export interface CallExtensionInput {
  orgId: string;
  callId: string;
  /** The paid minutes the call has now; the hold's key. */
  fromPaidMinutes: number;
  /** One more billed minute: the call's price plus the platform fee. */
  perMinuteMicros: number;
}

export type CallExtensionResult =
  | { kind: 'extended'; minutes: number; entry: LedgerEntryRow }
  | { kind: 'refused'; reason: SpendCutoffReason };

/**
 * Holds more minutes for a call in progress: up to one block, as many whole minutes as the wallet
 * and the monthly stop cap allow (`planCallExtension`). Under the wallet lock like every reserve, so
 * the check and the insert see one balance. The hold's key makes a replay return the first hold.
 * Callers lock the call row first (the same order as settlement), so a hold is never added to a
 * call that has already been settled.
 */
export async function extendCallHold(
  tx: Tx,
  input: CallExtensionInput,
): Promise<CallExtensionResult> {
  assertMicros(input.perMinuteMicros, 1);
  const walletRow = await walletOf(tx, input.orgId, true);
  const key = callExtendKey(input.callId, input.fromPaidMinutes);
  const existing = await entryByKey(tx, input.orgId, key);
  if (existing) {
    if (existing.kind !== 'reserve' || existing.walletId !== walletRow.id) {
      throw new LedgerError('idempotency_conflict');
    }
    const minutes = Math.floor(existing.heldDeltaMicros / input.perMinuteMicros);
    return { kind: 'extended', minutes, entry: existing };
  }
  const t = await totals(tx, walletRow, new Date());
  const plan = planCallExtension({
    availableMicros: t.balanceMicros - t.heldMicros,
    periodSpendMicros: t.periodSpendMicros,
    heldMicros: t.heldMicros,
    warnCapMicros: walletRow.warnCapMicros,
    stopCapMicros: walletRow.stopCapMicros,
    perMinuteMicros: input.perMinuteMicros,
  });
  if (plan.kind === 'refuse') return { kind: 'refused', reason: plan.reason };
  const [entry] = await tx
    .insert(ledgerEntry)
    .values({
      organizationId: input.orgId,
      walletId: walletRow.id,
      kind: 'reserve',
      ...planReserve(plan.amountMicros),
      refType: 'call',
      refId: input.callId,
      idempotencyKey: key,
      note: `Call extended, ${plan.minutes} min`,
    })
    .returning();
  if (!entry) throw new Error('reserve insert returned no row');
  return { kind: 'extended', minutes: plan.minutes, entry };
}

export interface CallSettleInput {
  orgId: string;
  callId: string;
  /** The hold placed when the call was authorized or answered (`call.reservation_id`). */
  reservationId: string;
  costMicros: number;
}

/**
 * Closes every hold of a call exactly once: the first hold is settled with the whole cost (a
 * capture, which may exceed that hold, or a release at cost 0) under `callSettleKey`, and each hold
 * added mid-call is released under its own key. The balance moves by the cost alone, held drops by
 * everything the call held, and a replay changes nothing. Returns the first hold's close.
 */
export async function settleCallHolds(tx: Tx, input: CallSettleInput): Promise<LedgerEntryRow> {
  const main = await settleReservation(tx, {
    orgId: input.orgId,
    reservationId: input.reservationId,
    costMicros: input.costMicros,
    idempotencyKey: callSettleKey(input.callId),
    refType: 'call',
    refId: input.callId,
  });
  const extensions = await tx
    .select()
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, input.orgId),
        eq(ledgerEntry.kind, 'reserve'),
        eq(ledgerEntry.refType, 'call'),
        eq(ledgerEntry.refId, input.callId),
        ne(ledgerEntry.id, input.reservationId),
      ),
    );
  for (const hold of extensions) {
    await settleReservation(tx, {
      orgId: input.orgId,
      reservationId: hold.id,
      costMicros: 0,
      idempotencyKey: `${hold.idempotencyKey}:settle`,
      refType: 'call',
      refId: input.callId,
    });
  }
  return main;
}

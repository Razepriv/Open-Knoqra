import { type MessagingChannel, messageCostMicros, type SpendDecision } from '@knoqra/core';
import { ledgerEntry, type Tx } from '@knoqra/db';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { grantsStarterCredit } from '../lib/voice-provider';
import { ensureWallet, reserve, settleReservation } from '../services/ledger';

export type MessageCostRefusal = Extract<
  SpendDecision['reason'],
  'insufficient_funds' | 'stop_cap'
>;

export const messageReserveKey = (messageId: string): string => `message:${messageId}:reserve`;
export const messageCaptureKey = (messageId: string): string => `message:${messageId}:capture`;
export const messageReleaseKey = (messageId: string): string => `message:${messageId}:release`;

export interface MessageReserveInput {
  orgId: string;
  actorUserId: string;
  channel: MessagingChannel;
  messageId: string;
  /** The sender the message goes out on: decides the development starter credit. */
  provider: 'fake' | 'telnyx';
}

export type MessageReserveResult =
  | { ok: true; decision: SpendDecision }
  | { ok: false; reason: MessageCostRefusal };

/**
 * The spend seam of the send path. Called inside the send transaction after gating and before the
 * message row is written; a refusal means nothing is written and the provider is never called.
 */
export interface MessageCostHook {
  beforeSend(tx: Tx, input: MessageReserveInput): Promise<MessageReserveResult>;
}

/**
 * Outside production, a workspace sending on the fake sender gets the same starter credit as one
 * on the fake voice provider; a Telnyx sender never does (the Telnyx voice rule).
 */
export function messageStarterCredit(env: Pick<Env, 'APP_ENV'>, provider: 'fake' | 'telnyx') {
  return grantsStarterCredit(env, provider === 'fake' ? { kind: 'fake' } : { kind: 'none' });
}

/** Holds the channel's flat rate on M2's ledger, keyed by the message id. */
export function ledgerMessageCost(env: Pick<Env, 'APP_ENV'>): MessageCostHook {
  return {
    async beforeSend(tx, input) {
      await ensureWallet(tx, input.orgId, {
        starterCredit: messageStarterCredit(env, input.provider),
      });
      const reserved = await reserve(tx, {
        orgId: input.orgId,
        amountMicros: messageCostMicros(input.channel),
        idempotencyKey: messageReserveKey(input.messageId),
        refType: 'message',
        refId: input.messageId,
        actorUserId: input.actorUserId,
      });
      if ('refused' in reserved) {
        const { reason } = reserved.refused;
        // `reserve` only refuses with a stop outcome: one of these two reasons.
        return { ok: false, reason: reason === 'stop_cap' ? 'stop_cap' : 'insufficient_funds' };
      }
      return { ok: true, decision: reserved.decision };
    },
  };
}

/** The message's hold on the ledger, if it was sent after message costs began. */
async function reservationOf(tx: Tx, orgId: string, messageId: string) {
  const [row] = await tx
    .select({ id: ledgerEntry.id, kind: ledgerEntry.kind })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, orgId),
        eq(ledgerEntry.idempotencyKey, messageReserveKey(messageId)),
      ),
    )
    .limit(1);
  return row?.kind === 'reserve' ? row : undefined;
}

export interface SettleMessageInput {
  orgId: string;
  messageId: string;
  channel: MessagingChannel;
  direction: 'inbound' | 'outbound';
  /** The message's status: the one it just moved to, or (for a final receipt) the one it holds. */
  status: string;
  /** A final `sent` receipt (Telnyx's `delivery_unconfirmed`): nothing further will arrive. */
  final?: boolean;
}

/**
 * Closes the message's hold when its status moves: delivered or read captures the rate, failed
 * releases it, and a final `sent` (ruling AS: Telnyx bills an unconfirmed message) captures it.
 * Every other status, an inbound message (free in Phase 1) and a message without a hold (sent
 * before message costs) change nothing. The ledger settles a hold at most once, so a
 * read after a capture, or a failure after one, returns the first settlement and posts nothing.
 */
export async function settleMessageCost(tx: Tx, input: SettleMessageInput): Promise<void> {
  if (input.direction !== 'outbound') return;
  const capture =
    input.status === 'delivered' ||
    input.status === 'read' ||
    (input.status === 'sent' && input.final === true);
  if (!capture && input.status !== 'failed') return;
  const hold = await reservationOf(tx, input.orgId, input.messageId);
  if (!hold) return;
  const costMicros = capture ? messageCostMicros(input.channel) : 0;
  const entry = await settleReservation(tx, {
    orgId: input.orgId,
    reservationId: hold.id,
    costMicros,
    idempotencyKey: capture
      ? messageCaptureKey(input.messageId)
      : messageReleaseKey(input.messageId),
    refType: 'message',
    refId: input.messageId,
  });
  // nextStatus never moves a delivered or read message to failed (or back). The one legal case is a
  // failure after a final `sent` captured: the capture stands (Telnyx billed it), and the warning
  // flags a provider that reported past its final event. Any other close of the other kind means
  // a bug. Say so, with ids and kinds only, as the call settle does.
  const expectedKind = capture ? 'capture' : 'release';
  if (entry.kind !== expectedKind || (capture && entry.balanceDeltaMicros !== -costMicros)) {
    logger.warn('ledger.settle_mismatch', {
      messageId: input.messageId,
      reservationId: hold.id,
      entryId: entry.id,
      expectedKind,
      actualKind: entry.kind,
    });
  }
}

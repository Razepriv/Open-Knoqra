import type { SetupFacts, TenDlcState, WhatsAppState } from '@knoqra/core';
import {
  callEvent,
  type PhoneNumberRow,
  phoneNumber,
  providerBalanceSnapshot,
  type Tx,
} from '@knoqra/db';
import { desc, max } from 'drizzle-orm';
import type { Env } from '../env';
import { loadConnection, selectVoiceProvider } from '../lib/voice-provider';

type FactsEnv = Pick<Env, 'PROVIDER' | 'APP_ENV' | 'FAKE_WEBHOOK_SECRET' | 'TELNYX_PUBLIC_KEY'>;

// Worst to best, so a higher index is the better state.
const TEN_DLC_RANK: readonly TenDlcState[] = [
  'none',
  'failed',
  'pending',
  'not_required',
  'registered',
];
const WHATSAPP_RANK: readonly WhatsAppState[] = ['none', 'rejected', 'pending', 'approved'];

function best<T extends string>(states: T[], rank: readonly T[], fallback: T): T {
  let winner = fallback;
  for (const state of states) {
    if (rank.indexOf(state) > rank.indexOf(winner)) winner = state;
  }
  return winner;
}

const usesCalls = (row: PhoneNumberRow) =>
  row.assignedUse === 'calls' || row.assignedUse === 'calls_and_messages';
const isAssigned = (row: PhoneNumberRow) => row.assignedUse !== 'unassigned';

/**
 * The workspace facts behind the setup checks (RLS-scoped `tx`). Integration with M3's
 * `channel_connection.registration_status` changes only this function (ruling R9).
 */
export async function gatherSetupFacts(tx: Tx, env: FactsEnv): Promise<SetupFacts> {
  const connection = await loadConnection(tx);
  const choice = selectVoiceProvider(env, connection);
  const [snapshot] = await tx
    .select({ status: providerBalanceSnapshot.status })
    .from(providerBalanceSnapshot)
    .orderBy(desc(providerBalanceSnapshot.capturedAt))
    .limit(1);
  const numbers = await tx.select().from(phoneNumber);
  const [lastEvent] = await tx.select({ at: max(callEvent.createdAt) }).from(callEvent);

  const active = numbers.filter((n) => n.status === 'active');
  const assigned = active.filter(isAssigned);
  const smsNumbers = active.filter((n) => n.sms);
  const tenDlcSource = assigned.length > 0 ? assigned : smsNumbers;
  const whatsappNumbers = active.filter((n) => n.whatsapp);

  return {
    provider: choice.kind,
    credentialStored: connection !== null,
    lastPoll: snapshot?.status ?? null,
    numbersSynced: numbers.length,
    assignedForCalls: active.some(usesCalls),
    // Plivo signs with the stored auth token; Telnyx needs the platform key or the connection's own.
    webhookKeyConfigured:
      connection?.provider === 'plivo' ||
      Boolean(env.TELNYX_PUBLIC_KEY) ||
      Boolean(connection?.webhookPublicKey),
    lastWebhookAt: lastEvent?.at ?? null,
    tenDlc: best(
      tenDlcSource.map((n) => n.tenDlcStatus),
      TEN_DLC_RANK,
      'none',
    ),
    whatsapp: best(
      whatsappNumbers.map((n) => n.whatsappStatus),
      WHATSAPP_RANK,
      'none',
    ),
  };
}

import type { MessagingChannel, RegistrationStatus } from '@knoqra/core';
import {
  type ChannelConnection,
  channelConnection,
  type PhoneNumberRow,
  type ProviderCredentialRow,
  phoneNumber,
  providerCredential,
  type Tx,
} from '@knoqra/db';
import { FakeProvider, type MessagingProvider, TelnyxMessagingProvider } from '@knoqra/providers';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { isValidMasterKey, openSecret, telnyxKeyAad } from '../lib/secret-envelope';
import { adapterFor } from '../routes/webhooks';
import {
  isActiveSynced,
  registrationIsSynced,
  sendableFor,
  smsRegistration,
} from '../services/sender-registration';

export interface Sender {
  id: string;
  channel: MessagingChannel;
  provider: 'fake' | 'telnyx';
  address: string;
  registrationStatus: RegistrationStatus;
  sandbox: boolean;
  liveEnabled: boolean;
}

export const SANDBOX_PREFIX = 'sandbox:';

/** Whether the organization has a saved Telnyx credential (RLS-scoped `tx`). */
export async function hasTelnyxCredential(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: providerCredential.id })
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  return row !== undefined;
}

/**
 * Whether sends through this provider and channel are switched on. Telnyx is live only when it is
 * the selected provider, the organization saved a Telnyx credential, and the channel's approval
 * flag is exactly `"true"`. The connection's registration status is the composer's to check.
 */
export function liveEnabled(
  provider: 'fake' | 'telnyx',
  channel: MessagingChannel,
  env: Env,
  hasCredential: boolean,
): boolean {
  if (provider === 'fake') return adapterFor('fake', env) !== null;
  if (env.PROVIDER !== 'telnyx' || !hasCredential) return false;
  const flag = channel === 'sms' ? env.SMS_10DLC_APPROVED : env.WHATSAPP_META_APPROVED;
  return flag === 'true';
}

export function toSender(row: ChannelConnection, env: Env, hasCredential: boolean): Sender {
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    address: row.address,
    registrationStatus: row.registrationStatus,
    sandbox: row.provider === 'fake',
    liveEnabled: liveEnabled(row.provider, row.channel, env, hasCredential),
  };
}

/** The credential flag as given, or loaded once when some telnyx row needs it. */
export async function credentialFor(
  tx: Tx,
  rows: ChannelConnection[],
  hasCredential: boolean | undefined,
): Promise<boolean> {
  if (hasCredential !== undefined) return hasCredential;
  return rows.some((row) => row.provider === 'telnyx') ? hasTelnyxCredential(tx) : false;
}

/**
 * The channel's sender. Pass `hasCredential` when the caller already loaded it for this request;
 * otherwise it is read here, and only for a telnyx sender.
 */
export async function senderFor(
  tx: Tx,
  env: Env,
  channel: MessagingChannel,
  hasCredential?: boolean,
): Promise<Sender | null> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.channel, channel))
    .limit(1);
  if (!row) return null;
  return toSender(row, env, await credentialFor(tx, [row], hasCredential));
}

export async function listSenders(tx: Tx, env: Env, hasCredential?: boolean): Promise<Sender[]> {
  const rows = await tx.select().from(channelConnection).orderBy(asc(channelConnection.channel));
  const credential = await credentialFor(tx, rows, hasCredential);
  return rows.map((row) => toSender(row, env, credential));
}

/** Decrypts a vault row's Telnyx key for one use. Throws SecretEnvelopeError; never log it. */
export function openTelnyxKey(
  credential: ProviderCredentialRow,
  masterKeyBase64: string,
): Promise<string> {
  return openSecret(
    {
      ciphertext: credential.apiKeyCiphertext,
      iv: credential.apiKeyIv,
      dekWrapped: credential.dekWrapped,
      dekIv: credential.dekIv,
      keyFingerprint: credential.keyFingerprint,
    },
    { masterKeyBase64, aad: telnyxKeyAad(credential.organizationId) },
  );
}

/**
 * The provider a sender sends through, or null when it cannot send here. For a live telnyx sender
 * the vault key is decrypted for this one send (never cached, never logged) with the same envelope
 * helpers as voice. `fetchImpl` is for tests: no network in tests.
 */
export async function messagingProviderFor(
  tx: Tx,
  sender: Sender,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<MessagingProvider | null> {
  if (sender.provider === 'fake') {
    if (!env.FAKE_WEBHOOK_SECRET || env.APP_ENV === 'production') return null;
    return new FakeProvider({
      webhookSecret: env.FAKE_WEBHOOK_SECRET,
      messageIdFactory: () => `fake_msg_${crypto.randomUUID().replaceAll('-', '')}`,
    });
  }
  if (!sender.liveEnabled) return null;
  const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKeyBase64)) return null;
  const [credential] = await tx
    .select()
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  if (!credential) return null;
  let apiKey: string;
  try {
    apiKey = await openTelnyxKey(credential, masterKeyBase64);
  } catch (error) {
    // Ids and the error name only: never key material.
    logger.warn('messaging.credential_unreadable', {
      orgId: credential.organizationId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
  return new TelnyxMessagingProvider({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/**
 * Deletes the organization's telnyx senders (RLS-scoped `tx`). The FK cascade, run as the table
 * owner, removes their routes, so none of their numbers resolves to this workspace any more. Called
 * in the same transaction that removes the Telnyx credential or replaces it with another key
 * (ruling AP): a route must not outlive the credential that proved the number was ours. Sandbox
 * senders are kept.
 */
export async function dropTelnyxSenders(tx: Tx): Promise<number> {
  const dropped = await tx
    .delete(channelConnection)
    .where(eq(channelConnection.provider, 'telnyx'))
    .returning({ id: channelConnection.id });
  return dropped.length;
}

/** The org's synced Telnyx number with this address, if the last sync listed one. */
export async function syncedTelnyxNumber(
  tx: Tx,
  e164: string,
): Promise<PhoneNumberRow | undefined> {
  const [row] = await tx
    .select()
    .from(phoneNumber)
    .where(and(eq(phoneNumber.provider, 'telnyx'), eq(phoneNumber.e164, e164)))
    .limit(1);
  return row;
}

/**
 * Brings the telnyx senders in line with the synced numbers (rulings AQ and AR), in M4's sync
 * transaction after the numbers are written. A sender whose number is no longer an active synced
 * Telnyx number is deleted with its routes: the workspace no longer controls it. An SMS sender is
 * also deleted when its number lost SMS, and otherwise takes the status its 10DLC state gives. A
 * WhatsApp sender keeps the status its owner set: M4's sync does not read WhatsApp yet.
 */
export async function refreshTelnyxSenders(tx: Tx): Promise<void> {
  const senders = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.provider, 'telnyx'))
    .for('update');
  if (senders.length === 0) return;
  const numbers = await tx
    .select()
    .from(phoneNumber)
    .where(
      and(
        eq(phoneNumber.provider, 'telnyx'),
        inArray(
          phoneNumber.e164,
          senders.map((s) => s.address),
        ),
      ),
    );
  const byE164 = new Map(numbers.map((n) => [n.e164, n]));
  for (const sender of senders) {
    const row = byE164.get(sender.address);
    const synced = registrationIsSynced(sender.channel);
    const keep = synced ? sendableFor(row, sender.channel) === 'ok' : isActiveSynced(row);
    if (!row || !keep) {
      await tx.delete(channelConnection).where(eq(channelConnection.id, sender.id));
      continue;
    }
    if (!synced) continue;
    const registrationStatus = smsRegistration(row);
    if (registrationStatus !== sender.registrationStatus) {
      await tx
        .update(channelConnection)
        .set({ registrationStatus })
        .where(eq(channelConnection.id, sender.id));
    }
  }
}

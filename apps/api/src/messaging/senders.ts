import type { MessagingChannel, RegistrationStatus } from '@knoqra/core';
import {
  type ChannelConnection,
  channelConnection,
  channelRoute,
  type PhoneNumberRow,
  type ProviderCredentialRow,
  phoneNumber,
  providerCredential,
  smsRegistration,
  type Tx,
} from '@knoqra/db';
import { FakeProvider, type MessagingProvider, TelnyxMessagingProvider } from '@knoqra/providers';
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import { isValidMasterKey, openSecret, telnyxKeyAad } from '../lib/secret-envelope';
import { adapterFor } from '../routes/webhooks';
import { registrationFor, sendableFor } from '../services/sender-registration';

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
 * Whether sends through this provider are switched on. Telnyx is live when it is the deployment's
 * provider and the organization saved a Telnyx credential. Whether this workspace may send on a
 * channel is its own registration status (US texting registration, Meta's approval), read from
 * the provider by the number sync and checked by the composer: the deployment-wide
 * SMS_10DLC_APPROVED and WHATSAPP_META_APPROVED flags are retired.
 */
export function liveEnabled(
  provider: 'fake' | 'telnyx',
  _channel: MessagingChannel,
  env: Env,
  hasCredential: boolean,
): boolean {
  if (provider === 'fake') return adapterFor('fake', env) !== null;
  return env.PROVIDER === 'telnyx' && hasCredential;
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
 * The organization's Telnyx API key, decrypted for one use (never cached, never logged), or null
 * without a credential or a readable key.
 */
export async function telnyxApiKey(tx: Tx, env: Env): Promise<string | null> {
  const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKeyBase64)) return null;
  const [credential] = await tx
    .select()
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  if (!credential) return null;
  try {
    return await openTelnyxKey(credential, masterKeyBase64);
  } catch (error) {
    logger.warn('messaging.credential_unreadable', {
      orgId: credential.organizationId,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/**
 * The organization's Telnyx messaging client, whatever its senders' states: for reads that need the
 * key (downloading inbound files). Null without a credential or a readable key.
 */
export async function telnyxMessagingClient(
  tx: Tx,
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<TelnyxMessagingProvider | null> {
  const apiKey = await telnyxApiKey(tx, env);
  return apiKey
    ? new TelnyxMessagingProvider({ apiKey, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
    : null;
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
 * Brings the telnyx senders in line with the synced numbers, in the sync transaction after the
 * numbers are written. A sender whose number is no longer an active synced Telnyx number that can
 * send on its channel is deleted with its routes: the workspace no longer controls it. Every other
 * sender takes the registration status its number gives (10DLC for SMS, Meta's approval for
 * WhatsApp). When the sync could not read WhatsApp (`whatsappSynced` false) WhatsApp senders are
 * left as they are. A channel with no sender at all gets one when a number qualifies: the
 * account's WhatsApp number (approved first, then the caller id), and for SMS the number the SMS
 * Enable flow registered.
 */
export async function refreshTelnyxSenders(
  tx: Tx,
  opts: { orgId?: string; whatsappSynced?: boolean } = {},
): Promise<void> {
  const whatsappSynced = opts.whatsappSynced !== false;
  const senders = await tx.select().from(channelConnection).for('update');
  const numbers = await tx.select().from(phoneNumber).where(eq(phoneNumber.provider, 'telnyx'));
  const byE164 = new Map(numbers.map((n) => [n.e164, n]));
  for (const sender of senders.filter((s) => s.provider === 'telnyx')) {
    if (sender.channel === 'whatsapp' && !whatsappSynced) continue;
    const row = byE164.get(sender.address);
    if (!row || sendableFor(row, sender.channel) !== 'ok') {
      await tx.delete(channelConnection).where(eq(channelConnection.id, sender.id));
      continue;
    }
    const registrationStatus = registrationFor(row, sender.channel);
    if (registrationStatus !== sender.registrationStatus) {
      await tx
        .update(channelConnection)
        .set({ registrationStatus })
        .where(eq(channelConnection.id, sender.id));
    }
  }
  const orgId = opts.orgId ?? numbers[0]?.organizationId;
  if (!orgId) return;
  const taken = new Set(senders.map((s) => s.channel));
  if (!taken.has('whatsapp') && whatsappSynced) {
    const candidate = await whatsappCandidate(tx, numbers);
    if (candidate) await adoptSender(tx, orgId, 'whatsapp', candidate);
  }
  if (!taken.has('sms')) {
    const [registration] = await tx
      .select({ phone: smsRegistration.phoneE164 })
      .from(smsRegistration)
      .limit(1);
    const row = registration ? byE164.get(registration.phone) : undefined;
    if (row && sendableFor(row, 'sms') === 'ok') await adoptSender(tx, orgId, 'sms', row);
  }
}

/** The number to make the WhatsApp sender: approved before pending, the caller id first. */
async function whatsappCandidate(
  tx: Tx,
  numbers: PhoneNumberRow[],
): Promise<PhoneNumberRow | undefined> {
  const usable = numbers.filter(
    (n) => sendableFor(n, 'whatsapp') === 'ok' && n.whatsappStatus !== 'rejected',
  );
  if (usable.length === 0) return undefined;
  const [credential] = await tx
    .select({ callerId: providerCredential.callerIdE164 })
    .from(providerCredential)
    .where(eq(providerCredential.provider, 'telnyx'))
    .limit(1);
  const rank = (n: PhoneNumberRow) =>
    (n.whatsappStatus === 'approved' ? 0 : 2) + (n.e164 === credential?.callerId ? 0 : 1);
  return [...usable].sort((a, b) => rank(a) - rank(b) || a.e164.localeCompare(b.e164))[0];
}

/**
 * Makes a synced number the channel's sender with its route. A number already routed to another
 * workspace is left alone (routes are readable across workspaces, ruling AJ).
 */
async function adoptSender(
  tx: Tx,
  orgId: string,
  channel: MessagingChannel,
  row: PhoneNumberRow,
): Promise<void> {
  const [routed] = await tx
    .select({ orgId: channelRoute.organizationId })
    .from(channelRoute)
    .where(
      and(
        eq(channelRoute.provider, 'telnyx'),
        eq(channelRoute.channel, channel),
        eq(channelRoute.address, row.e164),
      ),
    )
    .limit(1);
  if (routed && routed.orgId !== orgId) return;
  const [created] = await tx
    .insert(channelConnection)
    .values({
      organizationId: orgId,
      channel,
      provider: 'telnyx',
      address: row.e164,
      registrationStatus: registrationFor(row, channel),
    })
    .onConflictDoNothing()
    .returning({ id: channelConnection.id });
  if (!created) return;
  await tx
    .insert(channelRoute)
    .values({
      organizationId: orgId,
      provider: 'telnyx',
      channel,
      address: row.e164,
      connectionId: created.id,
    })
    .onConflictDoNothing({
      target: [channelRoute.provider, channelRoute.channel, channelRoute.address],
    });
}

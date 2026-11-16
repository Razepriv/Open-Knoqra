import type { MessagingChannel, RegistrationStatus, TenDlcState } from '@knoqra/core';
import type { PhoneNumberRow } from '@knoqra/db';

/**
 * How M4's synced number facts become an M3 sender's `registration_status` (rulings AQ and AR).
 * This sits next to setup-facts.ts on purpose: for SMS the phone_number row stays the one source
 * of the 10DLC state, and `gatherSetupFacts` keeps reading it unchanged (ruling R9). WhatsApp is
 * the exception until M4's sync reads Meta's state from Telnyx: an owner or admin sets it.
 */
const FROM_TEN_DLC: Record<TenDlcState, RegistrationStatus> = {
  registered: 'approved',
  // Nothing to register: the number may send. Telnyx's sync never reports it for an SMS number.
  not_required: 'approved',
  pending: 'pending',
  failed: 'rejected',
  none: 'not_started',
};

/** The SMS sender registration status the synced number's 10DLC state gives. */
export function smsRegistration(row: Pick<PhoneNumberRow, 'tenDlcStatus'>): RegistrationStatus {
  return FROM_TEN_DLC[row.tenDlcStatus];
}

/** Whether the channel's registration status comes from the synced number (else the owner's). */
export const registrationIsSynced = (channel: MessagingChannel): boolean => channel === 'sms';

export type Sendable = 'ok' | 'not_synced' | 'not_capable';

type SendableRow = Pick<
  PhoneNumberRow,
  'provider' | 'status' | 'voice' | 'sms' | 'mms' | 'whatsapp'
>;

/** An `active` Telnyx number (M4 maps only Telnyx's `active` to it) of the last sync. */
export const isActiveSynced = (row: SendableRow | undefined): row is SendableRow =>
  row?.provider === 'telnyx' && row.status === 'active';

/**
 * Whether a synced number may be a live sender on the channel. SMS needs the number's SMS
 * capability. WhatsApp needs any capability (ruling AR): M4's Telnyx sync never reports WhatsApp,
 * so its `whatsapp: false` is not evidence. `undefined` is a number the last sync did not list.
 */
export function sendableFor(row: SendableRow | undefined, channel: MessagingChannel): Sendable {
  if (!isActiveSynced(row)) return 'not_synced';
  const capable = channel === 'sms' ? row.sms : row.voice || row.sms || row.mms || row.whatsapp;
  return capable ? 'ok' : 'not_capable';
}

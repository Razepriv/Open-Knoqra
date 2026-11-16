import type {
  MessagingChannel,
  RegistrationStatus,
  TenDlcState,
  WhatsAppState,
} from '@knoqra/core';
import type { PhoneNumberRow } from '@knoqra/db';

/**
 * How synced number facts become a sender's `registration_status`. The phone_number row is the one
 * source of truth for both channels: the 10DLC state for SMS (ruling AQ, ruling R9), and since the
 * messaging upgrade Meta's approval for WhatsApp, which the Telnyx sync now reads from Telnyx's
 * WhatsApp number and business account lists (it replaced the owner's dropdown, ruling AR).
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

const FROM_WHATSAPP: Record<WhatsAppState, RegistrationStatus> = {
  approved: 'approved',
  pending: 'pending',
  rejected: 'rejected',
  none: 'not_started',
};

/** The WhatsApp sender registration status Meta's verdict on the synced number gives. */
export function whatsappRegistration(
  row: Pick<PhoneNumberRow, 'whatsappStatus'>,
): RegistrationStatus {
  return FROM_WHATSAPP[row.whatsappStatus];
}

/** The registration status a synced number gives a sender on the channel. */
export function registrationFor(
  row: Pick<PhoneNumberRow, 'tenDlcStatus' | 'whatsappStatus'>,
  channel: MessagingChannel,
): RegistrationStatus {
  return channel === 'sms' ? smsRegistration(row) : whatsappRegistration(row);
}

/** Whether the channel's registration status comes from the synced number: both channels now. */
export const registrationIsSynced = (_channel: MessagingChannel): boolean => true;

export type Sendable = 'ok' | 'not_synced' | 'not_capable';

type SendableRow = Pick<
  PhoneNumberRow,
  'provider' | 'status' | 'voice' | 'sms' | 'mms' | 'whatsapp'
>;

/** An `active` Telnyx number (M4 maps only Telnyx's `active` to it) of the last sync. */
export const isActiveSynced = (row: SendableRow | undefined): row is SendableRow =>
  row?.provider === 'telnyx' && row.status === 'active';

/**
 * Whether a synced number may be a live sender on the channel: SMS needs the number's SMS
 * capability, WhatsApp its WhatsApp one (the Telnyx sync lists the account's WhatsApp numbers).
 * `undefined` is a number the last sync did not list.
 */
export function sendableFor(row: SendableRow | undefined, channel: MessagingChannel): Sendable {
  if (!isActiveSynced(row)) return 'not_synced';
  const capable = channel === 'sms' ? row.sms : row.whatsapp;
  return capable ? 'ok' : 'not_capable';
}

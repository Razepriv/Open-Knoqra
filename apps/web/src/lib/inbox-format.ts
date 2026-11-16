import type { components } from '@knoqra/api-client';
import { ApiError } from './api';
import { type DayGroup, groupByDay } from './contact360';
import { isOwnerOrAdmin } from './wallet-form';

// Pure inbox helpers. Each takes an explicit `now`, and a `timeZone` where it formats a clock time,
// so the output is the same wherever the tests run.

export type ComposerState = components['schemas']['Composer'];
export type MessageStatus = components['schemas']['Message']['status'];
export type MessageError = components['schemas']['Message']['error'];
export type InboxChannel = 'sms' | 'whatsapp';
type Sender = components['schemas']['MessagingSender'];
type Template = components['schemas']['MessageTemplate'];
export type StateTone = 'ok' | 'warn' | 'bad';

const MINUTE_MS = 60_000;
const WINDOW_MS = 24 * 60 * MINUTE_MS;

export const CHANNEL_LABEL: Record<InboxChannel, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

function closedAt(expiresAt: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date(expiresAt));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('hour')}:${pick('minute')}`;
}

/** The WhatsApp service window: time left while open, when it closed, or that nothing came in yet. */
export function windowLabel(expiresAt: string | null, now: Date, timeZone?: string): string {
  if (expiresAt === null) return 'No inbound yet';
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return `Closed ${closedAt(expiresAt, timeZone)}`;
  const minutes = Math.floor(left / MINUTE_MS);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} m left` : `${minutes} m left`;
}

/** The share of the 24 h window still open, from 0 to 100. */
export function windowPercent(expiresAt: string | null, now: Date): number {
  if (expiresAt === null) return 0;
  const left = new Date(expiresAt).getTime() - now.getTime();
  return Math.round(Math.min(1, Math.max(0, left / WINDOW_MS)) * 100);
}

const STATUS_TEXT: Record<Exclude<MessageStatus, 'failed'>, string> = {
  queued: 'SENDING…',
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  received: 'RECEIVED',
};

export function statusMeta(status: MessageStatus, error: MessageError): string {
  if (status !== 'failed') return STATUS_TEXT[status];
  return error ? `FAILED · ${error.message}` : 'FAILED';
}

const BLOCKED_LABEL: Partial<Record<ComposerState['reason'], string>> = {
  opted_out: 'Opted out',
  do_not_contact: 'Do not contact',
  revoked: 'Consent revoked',
  consent_required: 'Needs consent',
};

/** The one-line state shown beside the dot on a thread row. */
export function threadState(
  channel: InboxChannel,
  composer: ComposerState,
  now: Date,
  timeZone?: string,
): { label: string; tone: StateTone } {
  switch (composer.mode) {
    case 'free':
      return {
        label:
          channel === 'whatsapp' ? windowLabel(composer.windowExpiresAt, now, timeZone) : 'Ready',
        tone: 'ok',
      };
    case 'template_only':
      return { label: 'Template needed', tone: 'warn' };
    case 'paused':
      return { label: 'Sending paused', tone: 'warn' };
    case 'blocked':
      return { label: BLOCKED_LABEL[composer.reason] ?? 'Blocked', tone: 'bad' };
  }
}

interface Copy {
  title: string;
  body: string;
}

const NONE: Copy = { title: '', body: '' };

function pausedCopy(channel: InboxChannel, reason: ComposerState['reason']): Copy {
  const name = CHANNEL_LABEL[channel];
  switch (reason) {
    case 'registration_pending':
      return channel === 'sms'
        ? {
            title: 'SMS sending paused · 10DLC',
            body: 'Inbound SMS is received and kept. Outbound starts when 10DLC is approved.',
          }
        : {
            title: 'WhatsApp sending paused · Meta approval',
            body: 'Inbound WhatsApp is received and kept. Outbound starts when Meta approves your business.',
          };
    case 'registration_rejected':
      return {
        title: 'Registration rejected',
        body: 'Fix the registration in Numbers before sending.',
      };
    case 'live_disabled':
      return {
        title: 'Live sending is off',
        body: 'Sending stays off until US texting registration (SMS) or WhatsApp approval is confirmed.',
      };
    default:
      return {
        title: `No ${name} sender connected`,
        body: 'Connect a number in Numbers to send. Inbound replies still arrive.',
      };
  }
}

function blockedCopy(channel: InboxChannel, reason: ComposerState['reason']): Copy {
  switch (reason) {
    case 'opted_out':
      return {
        title: 'Opted out · messages blocked',
        body: 'They replied STOP. Messages stay blocked until they reply START.',
      };
    case 'do_not_contact':
      return {
        title: 'Do not contact · messages blocked',
        body: 'Do not contact. Policy, not a task.',
      };
    case 'revoked':
      return {
        title: 'Consent revoked · messages blocked',
        body: 'Record new consent on the contact before messaging.',
      };
    default:
      return {
        title: 'Needs consent before messaging',
        body: `Record that this contact agreed to receive ${CHANNEL_LABEL[channel]} before you send.`,
      };
  }
}

/** The title and explanation for a composer that cannot send freely. */
export function composerCopy(channel: InboxChannel, composer: ComposerState): Copy {
  switch (composer.mode) {
    case 'free':
      return NONE;
    case 'template_only':
      return {
        title: 'Window closed · templates only',
        body: "WhatsApp allows only approved templates more than 24 hours after the contact's last message.",
      };
    case 'paused':
      return pausedCopy(channel, composer.reason);
    case 'blocked':
      return blockedCopy(channel, composer.reason);
  }
}

/**
 * Where the composer points when it cannot send: live sending starts with the Telnyx connection,
 * which is set up in the Voice section of Settings (`/numbers` is still a stub).
 */
export function composerLink(
  composer: ComposerState,
): { label: string; to: '/settings'; hash: 'voice-heading' } | null {
  return composer.mode === 'paused' && composer.reason === 'live_disabled'
    ? { label: 'Set up live sending', to: '/settings', hash: 'voice-heading' }
    : null;
}

/** The sender card: which number sends, and whether anything leaves KNOQRA. */
export function senderSummary(sender: Sender): { title: string; note: string } {
  if (sender.sandbox) {
    return {
      title: 'Sandbox sender',
      note: 'Messages stay inside KNOQRA. Nothing reaches a real phone.',
    };
  }
  return { title: sender.address, note: telnyxNote(sender) };
}

const REGISTRATION_NOTE: Record<Sender['registrationStatus'], string> = {
  not_started: 'Registration not started',
  pending: 'Registration pending',
  approved: 'Live',
  rejected: 'Registration rejected',
};

/** "Live" only when live sending is on and the registration is approved, as the composer gates. */
function telnyxNote(sender: Sender): string {
  return sender.liveEnabled ? REGISTRATION_NOTE[sender.registrationStatus] : 'Live sending off';
}

/**
 * The live sender control is for owners and admins with a saved Telnyx connection, and only on a
 * deployment that sends through Telnyx at all.
 */
export function showLiveSender(input: {
  role: string | undefined;
  hasConnection: boolean;
  liveAvailable: boolean;
}): boolean {
  return input.liveAvailable && input.hasConnection && isOwnerOrAdmin(input.role);
}

/** A pending WhatsApp template with its Meta name and language can be marked approved in Meta. */
export function canMarkApproved(template: Template): boolean {
  return (
    template.channel === 'whatsapp' &&
    template.approvalStatus === 'pending' &&
    template.archivedAt === null &&
    Boolean(template.whatsappTemplateName && template.whatsappLanguage)
  );
}

const LIVE_SENDER_COPY: Record<number, string> = {
  400: 'Add a caller ID to your phone connection in Settings first.',
  403: 'Only owners and admins can change senders.',
  409: "This number can't be used as a sender.",
  422: 'Connect your phone provider in Settings first.',
  502: 'Your phone provider could not be reached. Try again in a moment.',
};

/**
 * Who decides a live sender's registration status. SMS follows the 10DLC state in Numbers.
 * WhatsApp is set by the owner until the Numbers sync can read Meta's approval (ruling AR).
 */
export function liveSenderStatus(channel: InboxChannel): { settable: boolean; note: string } {
  return channel === 'whatsapp'
    ? {
        settable: true,
        note: 'Set it to Approved once WhatsApp approves this number.',
      }
    : { settable: false, note: 'Registration status comes from Numbers.' };
}

/** The refusals that are not a missing connection, told apart by the API's error code. */
const LIVE_SENDER_CODE_COPY: Record<string, string> = {
  credential_changed: 'Your phone connection changed. Try again.',
  number_not_synced: 'Sync your numbers in Numbers, then try again with an active number.',
  number_not_owned: "This number isn't in your connected account.",
  provider_auth: 'The saved API key was not accepted. Check it in Settings.',
  not_configured: "Live sending isn't available on this deployment.",
};

/** Our wording for a failed live sender change; never the server's text. */
export function liveSenderErrorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Try again in a moment.';
  const byCode = error.code ? LIVE_SENDER_CODE_COPY[error.code] : undefined;
  return byCode ?? LIVE_SENDER_COPY[error.status] ?? 'Something went wrong. Try again in a moment.';
}

/** The Inbox pins day labels to the design's style ("MON 9 NOV"), whatever the browser locale. */
const DAY_LABEL_LOCALE = 'en-GB';

/** Thread items grouped by day, oldest first, labelled `TODAY`, `YESTERDAY` or `MON 9 NOV`. */
export function threadDayGroups<T extends { occurredAt: string }>(
  items: readonly T[],
  now: Date,
  timeZone?: string,
): DayGroup<T>[] {
  return groupByDay(items, now, timeZone, DAY_LABEL_LOCALE).map((group) => ({
    ...group,
    label: group.label.toUpperCase(),
  }));
}

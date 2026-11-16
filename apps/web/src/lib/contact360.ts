import type { components } from '@knoqra/api-client';
import { CHANNEL_ORDER, type Channel } from './contact360-channels';
import { formatDayLabel } from './format';

export { CHANNEL_ORDER, type Channel };

export type ChannelPermission = components['schemas']['ChannelPermission'];
export type Decision = ChannelPermission['decision'];
export type TimelineEvent = components['schemas']['TimelineEvent'];
export type DuplicateSuggestion = components['schemas']['DuplicateSuggestion'];

const CHANNEL_LABELS: Record<Channel, string> = {
  manual_call: 'Manual calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  ai_voice: 'AI voice',
  recording: 'Recording',
};

export function channelLabel(channel: Channel): string {
  return CHANNEL_LABELS[channel];
}

// The decisions below come from the server. These helpers only choose words and colours for them;
// nothing here decides whether a channel is allowed.

type Reason = Decision['reason'];

const DO_NOT_CONTACT = 'Do not contact. Policy, not a task.';

/**
 * Words for every channel and reason. A reason that the server would not give a channel (such as
 * AI voice rules on SMS) still has its own line, so nothing falls back to another channel's wording.
 */
const DECISION_COPY: Record<Channel, Record<Reason, string>> = {
  manual_call: {
    granted: 'Consent is on file for calls.',
    unknown_manual_call: "Confirm you're authorized before calling.",
    consent_required: 'Needs consent before calling.',
    ai_voice_requires_consent: 'AI voice has its own consent. Manual calls are assessed apart.',
    revoked: 'Consent was withdrawn. Calls stay off.',
    opted_out: 'Opted out. Calls stay off.',
    do_not_contact: DO_NOT_CONTACT,
  },
  sms: {
    granted: 'Consent is on file for messaging.',
    unknown_manual_call: 'Manual call checks do not apply to SMS.',
    consent_required: 'Needs consent before messaging.',
    ai_voice_requires_consent: 'AI voice rules do not apply to SMS.',
    revoked: 'Consent was withdrawn. Messages stay off.',
    opted_out: 'Opted out. Messages stay off.',
    do_not_contact: DO_NOT_CONTACT,
  },
  whatsapp: {
    granted: 'Consent is on file for messaging.',
    unknown_manual_call: 'Manual call checks do not apply to WhatsApp.',
    consent_required: 'Needs consent before messaging.',
    ai_voice_requires_consent: 'AI voice rules do not apply to WhatsApp.',
    revoked: 'Consent was withdrawn. Messages stay off.',
    opted_out: 'Opted out. Messages stay off.',
    do_not_contact: DO_NOT_CONTACT,
  },
  ai_voice: {
    granted: 'Consent is on file for AI voice.',
    unknown_manual_call: 'Manual call checks do not apply to AI voice.',
    consent_required: 'AI voice needs explicit consent.',
    ai_voice_requires_consent: 'AI voice is off without explicit consent.',
    revoked: 'Consent was withdrawn. AI voice stays off.',
    opted_out: 'Opted out. Calls stay off.',
    do_not_contact: DO_NOT_CONTACT,
  },
  recording: {
    granted: 'Consent is on file for recording.',
    unknown_manual_call: 'Manual call checks do not apply to recording.',
    consent_required: 'Recording needs consent before it can start.',
    ai_voice_requires_consent: 'AI voice rules do not apply to recording.',
    revoked: 'Consent was withdrawn. Recording stays off.',
    opted_out: 'Opted out. Recording stays off.',
    do_not_contact: DO_NOT_CONTACT,
  },
};

export function decisionCopy(channel: Channel, reason: Reason): string {
  return DECISION_COPY[channel][reason];
}

/** The StatusDot colour for a server outcome: allowed is green, needs review amber, blocked red. */
export function decisionTone(outcome: Decision['outcome']): 'ok' | 'warn' | 'bad' {
  if (outcome === 'allowed') return 'ok';
  if (outcome === 'needs_review') return 'warn';
  return 'bad';
}

const STATUS_LABELS: Record<Decision['outcome'], string> = {
  allowed: 'Allowed',
  needs_review: 'Needs review',
  blocked: 'Blocked',
};

/** The outcome in words, so the dot's colour is never the only signal. */
export function statusLabel(outcome: Decision['outcome']): string {
  return STATUS_LABELS[outcome];
}

const PILL_NOUN: Partial<Record<Channel, string>> = {
  manual_call: 'Calls',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

const BLOCK_REASON: Record<Decision['reason'], string> = {
  do_not_contact: 'Do not contact',
  opted_out: 'Opted out',
  revoked: 'Consent revoked',
  consent_required: 'Needs consent',
  ai_voice_requires_consent: 'Needs consent',
  granted: 'Policy',
  unknown_manual_call: 'Policy',
};

/** "Calls blocked · Do not contact" for a blocked channel; null when it is not blocked. */
export function blockedPillText(
  channel: Channel,
  permission: ChannelPermission | undefined,
): string | null {
  if (permission?.decision.outcome !== 'blocked') return null;
  const noun = PILL_NOUN[channel] ?? channelLabel(channel);
  return `${noun} blocked · ${BLOCK_REASON[permission.decision.reason]}`;
}

/**
 * Why an archived or merged contact cannot be messaged (the API refuses to open a conversation
 * with one), as a short pill label and a full sentence; null when it can be messaged.
 */
export function readOnlyMessageReason(contact: {
  archivedAt: string | null;
  mergedIntoId: string | null;
}): { short: string; full: string } | null {
  if (contact.mergedIntoId !== null) {
    return {
      short: 'Merged',
      full: "Merged contacts can't be messaged. Message the contact it was merged into.",
    };
  }
  if (contact.archivedAt !== null) {
    return {
      short: 'Archived',
      full: "Archived contacts can't be messaged. Restore the contact first.",
    };
  }
  return null;
}

// --- Time -------------------------------------------------------------------------------------

/** Year, month and day of `date` in `timeZone`, as a sortable "2026-11-12" key. */
function dayKey(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export interface DayGroup<T> {
  label: string;
  events: T[];
}

/** Groups newest-first events by the day they happened, as "Today", "Yesterday" or "WED 4 NOV". */
export function groupByDay<T extends { occurredAt: string }>(
  events: readonly T[],
  now: Date = new Date(),
  timeZone?: string,
  locale?: string,
): DayGroup<T>[] {
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
  const groups: DayGroup<T>[] = [];
  let currentKey = '';
  for (const event of events) {
    const at = new Date(event.occurredAt);
    const key = dayKey(at, timeZone);
    if (key !== currentKey) {
      const label =
        key === today
          ? 'Today'
          : key === yesterday
            ? 'Yesterday'
            : formatDayLabel(at, timeZone, locale);
      groups.push({ label, events: [] });
      currentKey = key;
    }
    groups[groups.length - 1]?.events.push(event);
  }
  return groups;
}

// --- Provenance and duplicates -----------------------------------------------------------------

export function provenanceLabel(source: string, sourceDetail: string | null): string {
  if (source === 'manual') return 'Added manually';
  if (source === 'import') {
    return sourceDetail ? `Imported from ${sourceDetail}` : 'Imported from a CSV file';
  }
  if (source === 'app') return 'Added in KNOQRA';
  return `Source: ${source}`;
}

const REASON_LABELS: Record<DuplicateSuggestion['reasons'][number], string> = {
  same_name: 'Same name',
  same_email: 'Same email',
  same_name_and_company: 'Same name and company',
};

export function duplicateReasonLabel(reason: DuplicateSuggestion['reasons'][number]): string {
  return REASON_LABELS[reason];
}

/** Words for each consent source the API records (`contact_permission_event.source`). */
const CONSENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  app: 'Recorded in KNOQRA',
  import: 'From a CSV import',
  manual: 'Recorded manually',
  merge: 'Kept from a merged contact',
  inbound_stop: 'Replied STOP',
  inbound_start: 'Replied START',
  system: 'Set by KNOQRA',
};

/** Where a consent decision was recorded, in words. */
export function consentSourceLabel(source: string | null): string {
  if (source === null) return 'No consent recorded';
  const label = Object.hasOwn(CONSENT_SOURCE_LABELS, source)
    ? CONSENT_SOURCE_LABELS[source]
    : undefined;
  return label ?? `Source: ${source}`;
}

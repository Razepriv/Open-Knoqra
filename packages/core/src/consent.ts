export const CHANNELS = ['manual_call', 'sms', 'whatsapp', 'ai_voice', 'recording'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PERMISSION_STATUSES = ['granted', 'revoked', 'opted_out', 'do_not_contact'] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export type ChannelDecision = {
  outcome: 'allowed' | 'needs_review' | 'blocked';
  reason:
    | 'granted'
    | 'unknown_manual_call'
    | 'consent_required'
    | 'ai_voice_requires_consent'
    | 'revoked'
    | 'opted_out'
    | 'do_not_contact';
};

/** Decides whether a channel may be used given the contact's current permission (undefined = unknown). */
export function evaluateChannel(
  channel: Channel,
  status: PermissionStatus | undefined,
): ChannelDecision {
  switch (status) {
    case 'granted':
      return { outcome: 'allowed', reason: 'granted' };
    case 'revoked':
    case 'opted_out':
    case 'do_not_contact':
      return { outcome: 'blocked', reason: status };
    default:
      if (channel === 'manual_call')
        return { outcome: 'needs_review', reason: 'unknown_manual_call' };
      if (channel === 'ai_voice') {
        return { outcome: 'blocked', reason: 'ai_voice_requires_consent' };
      }
      return { outcome: 'blocked', reason: 'consent_required' };
  }
}

interface PermissionEvent {
  channel: Channel;
  status: PermissionStatus;
  createdAt: Date;
  id: string;
}

/**
 * Latest event per channel by (createdAt, id). Does not mutate its input.
 * Callers should pass the latest event per channel, not full history. Writers that change consent
 * must hold the contact row lock and timestamp with clock_timestamp(), so this order is the commit order.
 */
export function currentPermissions(
  events: readonly PermissionEvent[],
): Partial<Record<Channel, PermissionStatus>> {
  const latest = new Map<Channel, PermissionEvent>();
  for (const event of events) {
    const prior = latest.get(event.channel);
    const newer =
      prior === undefined ||
      event.createdAt.getTime() > prior.createdAt.getTime() ||
      (event.createdAt.getTime() === prior.createdAt.getTime() && event.id > prior.id);
    if (newer) latest.set(event.channel, event);
  }
  const result: Partial<Record<Channel, PermissionStatus>> = {};
  for (const [channel, event] of latest) result[channel] = event.status;
  return result;
}

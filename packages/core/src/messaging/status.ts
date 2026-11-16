export const MESSAGING_CHANNELS = ['sms', 'whatsapp'] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

export const REGISTRATION_STATUSES = ['not_started', 'pending', 'approved', 'rejected'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const MESSAGE_STATUSES = [
  'received',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

const RANK: Partial<Record<MessageStatus, number>> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Applies a provider status update to a message. `received` never changes and `failed` is
 * terminal; `failed` applies only from queued or sent; otherwise only a higher rank wins.
 */
export function nextStatus(
  current: MessageStatus,
  incoming: MessageStatus,
): { status: MessageStatus; changed: boolean } {
  const keep = { status: current, changed: false };
  if (current === 'received' || current === 'failed' || incoming === 'received') return keep;
  if (incoming === 'failed') {
    return current === 'queued' || current === 'sent' ? { status: 'failed', changed: true } : keep;
  }
  const from = RANK[current];
  const to = RANK[incoming];
  if (from === undefined || to === undefined || to <= from) return keep;
  return { status: incoming, changed: true };
}

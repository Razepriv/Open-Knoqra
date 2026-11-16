import { evaluateChannel, type PermissionStatus } from '../consent';
import type { MessagingChannel, RegistrationStatus } from './status';

export const WHATSAPP_WINDOW_MS = 86_400_000;

export type ComposerMode = 'free' | 'template_only' | 'paused' | 'blocked';
export type ComposerReason =
  | 'ok'
  | 'consent_required'
  | 'revoked'
  | 'opted_out'
  | 'do_not_contact'
  | 'no_sender'
  | 'registration_pending'
  | 'registration_rejected'
  | 'live_disabled'
  | 'window_closed';

export interface ComposerState {
  mode: ComposerMode;
  reason: ComposerReason;
  windowExpiresAt: Date | null;
}

type BlockedReason = 'consent_required' | 'revoked' | 'opted_out' | 'do_not_contact';

/** Decides what the composer may do for a conversation. The first matching rule wins. */
export function composerState(input: {
  channel: MessagingChannel;
  consent: PermissionStatus | undefined;
  sender: { registrationStatus: RegistrationStatus; liveEnabled: boolean } | null;
  lastInboundAt: Date | null;
  now: Date;
}): ComposerState {
  const { channel, consent, sender, lastInboundAt, now } = input;
  const windowExpiresAt =
    channel === 'whatsapp' && lastInboundAt
      ? new Date(lastInboundAt.getTime() + WHATSAPP_WINDOW_MS)
      : null;
  const state = (mode: ComposerMode, reason: ComposerReason): ComposerState => ({
    mode,
    reason,
    windowExpiresAt,
  });

  const decision = evaluateChannel(channel, consent);
  if (decision.outcome === 'blocked') return state('blocked', decision.reason as BlockedReason);
  if (sender === null) return state('paused', 'no_sender');
  if (sender.registrationStatus === 'rejected') return state('paused', 'registration_rejected');
  if (sender.registrationStatus !== 'approved') return state('paused', 'registration_pending');
  if (!sender.liveEnabled) return state('paused', 'live_disabled');
  if (channel === 'whatsapp' && (windowExpiresAt === null || now >= windowExpiresAt)) {
    return state('template_only', 'window_closed');
  }
  return state('free', 'ok');
}

import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  type Channel,
  type ChannelDecision,
  currentPermissions,
  evaluateChannel,
  PERMISSION_STATUSES,
  type PermissionStatus,
} from './consent';

type Cell = [Channel, PermissionStatus | undefined, ChannelDecision];

const blockedBy = (status: PermissionStatus): ChannelDecision['reason'] => status;
const cells: Cell[] = [];
for (const channel of CHANNELS) {
  for (const status of PERMISSION_STATUSES) {
    cells.push([
      channel,
      status,
      status === 'granted'
        ? { outcome: 'allowed', reason: 'granted' }
        : { outcome: 'blocked', reason: blockedBy(status) },
    ]);
  }
  const unknown: ChannelDecision =
    channel === 'manual_call'
      ? { outcome: 'needs_review', reason: 'unknown_manual_call' }
      : channel === 'ai_voice'
        ? { outcome: 'blocked', reason: 'ai_voice_requires_consent' }
        : { outcome: 'blocked', reason: 'consent_required' };
  cells.push([channel, undefined, unknown]);
}

describe('evaluateChannel', () => {
  it('covers every channel and status', () => {
    expect(CHANNELS).toEqual(['manual_call', 'sms', 'whatsapp', 'ai_voice', 'recording']);
    expect(PERMISSION_STATUSES).toEqual(['granted', 'revoked', 'opted_out', 'do_not_contact']);
    expect(cells).toHaveLength(CHANNELS.length * (PERMISSION_STATUSES.length + 1));
  });

  it.each(cells)('%s with status %s', (channel, status, expected) => {
    expect(evaluateChannel(channel, status)).toEqual(expected);
  });
});

describe('currentPermissions', () => {
  const at = (iso: string) => new Date(iso);

  it('returns an empty object when there are no events', () => {
    expect(currentPermissions([])).toEqual({});
  });

  it('the latest event per channel wins', () => {
    const events = [
      { id: 'cp_1', channel: 'sms', status: 'granted', createdAt: at('2026-01-01T00:00:00Z') },
      { id: 'cp_2', channel: 'sms', status: 'revoked', createdAt: at('2026-01-02T00:00:00Z') },
      { id: 'cp_3', channel: 'ai_voice', status: 'granted', createdAt: at('2026-01-01T00:00:00Z') },
    ] as const;
    expect(currentPermissions(events)).toEqual({ sms: 'revoked', ai_voice: 'granted' });
  });

  it('is independent of input order', () => {
    const events = [
      { id: 'cp_2', channel: 'sms', status: 'revoked', createdAt: at('2026-01-02T00:00:00Z') },
      { id: 'cp_1', channel: 'sms', status: 'granted', createdAt: at('2026-01-01T00:00:00Z') },
    ] as const;
    expect(currentPermissions(events)).toEqual({ sms: 'revoked' });
  });

  it('breaks a createdAt tie by id descending', () => {
    const when = at('2026-01-01T00:00:00Z');
    const events = [
      { id: 'cp_b', channel: 'sms', status: 'opted_out', createdAt: when },
      { id: 'cp_a', channel: 'sms', status: 'granted', createdAt: when },
      { id: 'cp_c', channel: 'sms', status: 'do_not_contact', createdAt: when },
    ] as const;
    expect(currentPermissions(events)).toEqual({ sms: 'do_not_contact' });
    expect(currentPermissions([...events].reverse())).toEqual({ sms: 'do_not_contact' });
  });

  it('does not mutate its input', () => {
    const events = Object.freeze([
      Object.freeze({
        id: 'cp_2',
        channel: 'sms' as const,
        status: 'revoked' as const,
        createdAt: at('2026-01-02T00:00:00Z'),
      }),
      Object.freeze({
        id: 'cp_1',
        channel: 'sms' as const,
        status: 'granted' as const,
        createdAt: at('2026-01-01T00:00:00Z'),
      }),
    ]);
    const snapshot = events.map((e) => e.id);
    expect(() => currentPermissions(events)).not.toThrow();
    expect(events.map((e) => e.id)).toEqual(snapshot);
  });
});

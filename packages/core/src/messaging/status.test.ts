import { describe, expect, it } from 'vitest';
import { MESSAGE_STATUSES, type MessageStatus, nextStatus } from './status';

const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

describe('nextStatus full table', () => {
  for (const current of MESSAGE_STATUSES) {
    for (const incoming of MESSAGE_STATUSES) {
      let expected: { status: MessageStatus; changed: boolean };
      if (current === 'received' || current === 'failed' || incoming === 'received') {
        expected = { status: current, changed: false };
      } else if (incoming === 'failed') {
        const can = current === 'queued' || current === 'sent';
        expected = { status: can ? 'failed' : current, changed: can };
      } else {
        const up = (rank[incoming] as number) > (rank[current] as number);
        expected = { status: up ? incoming : current, changed: up };
      }
      it(`${current} + ${incoming}`, () => {
        expect(nextStatus(current, incoming)).toEqual(expected);
      });
    }
  }
  it('keeps explicit examples', () => {
    expect(nextStatus('delivered', 'sent')).toEqual({ status: 'delivered', changed: false });
    expect(nextStatus('read', 'failed')).toEqual({ status: 'read', changed: false });
    expect(nextStatus('failed', 'delivered')).toEqual({ status: 'failed', changed: false });
    expect(nextStatus('queued', 'read')).toEqual({ status: 'read', changed: true });
  });
});

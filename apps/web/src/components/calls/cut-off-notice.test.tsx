// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../../lib/calls';
import { CutOffWarning } from './cut-off-notice';

/*
 * The cut-off warning on a live call: why the call will end (an alert, announced once) and a
 * countdown (a timer, not announced on each tick). It renders nothing without a planned cut-off.
 */

const NOW = new Date('2026-11-17T10:09:00.000Z');

vi.mock('../../lib/use-now', () => ({ useNow: () => NOW }));

afterEach(cleanup);

const call = (over: Partial<Call>): Call => ({
  id: 'cl_a',
  userId: 'u_a',
  direction: 'outbound',
  state: 'connected',
  contact: null,
  fromE164: '+12025550100',
  toE164: '+12025550123',
  createdAt: '2026-11-17T09:59:50.000Z',
  answeredAt: '2026-11-17T10:00:00.000Z',
  endedAt: null,
  billableSeconds: null,
  costMicros: null,
  hangupCause: null,
  outcome: null,
  outcomeNote: null,
  reviewConfirmed: false,
  paidUntil: '2026-11-17T10:10:00.000Z',
  cutOff: null,
  ...over,
});

describe('CutOffWarning', () => {
  it('warns that the call will end and counts down to the cut-off', () => {
    render(
      <CutOffWarning
        call={call({ cutOff: { reason: 'insufficient_funds', at: '2026-11-17T10:09:50.000Z' } })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Out of credit. This call will end soon. Add credit to keep talking.',
    );
    expect(screen.getByRole('timer', { name: 'Time left before the call ends' }).textContent).toBe(
      '0:50',
    );
  });

  it('names the spend cap when that is the limit', () => {
    render(
      <CutOffWarning
        compact
        call={call({ cutOff: { reason: 'stop_cap', at: '2026-11-17T10:09:50.000Z' } })}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Monthly spend cap reached/);
  });

  it('renders nothing without a planned cut-off, or once the call has ended', () => {
    const { container, rerender } = render(<CutOffWarning call={call({})} />);
    expect(container.innerHTML).toBe('');
    rerender(
      <CutOffWarning
        call={call({
          state: 'completed',
          cutOff: { reason: 'insufficient_funds', at: '2026-11-17T10:09:50.000Z' },
        })}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

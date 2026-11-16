// @vitest-environment jsdom
import { EMERGENCY_CALL_MESSAGE } from '@knoqra/core';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dialer as DialerComponent } from './dialer';

/*
 * The dialer's emergency rule, with its data hooks stubbed: the pre-call check answers "allowed"
 * for any number it is asked about, so only the dialer itself can keep the Call button disabled.
 */

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/setup">{children}</a>,
}));

vi.mock('./call-session', () => ({
  useCallSession: () => ({
    current: null,
    dialing: false,
    realtime: 'open',
    error: null,
    dial: vi.fn(),
    clearError: vi.fn(),
  }),
  sessionErrorCopy: () => '',
}));

vi.mock('./dial-state-banner', () => ({ DialStateBanner: () => null }));

vi.mock('../../lib/voice-connection', () => ({
  useVoiceStatus: () => ({ data: { provider: 'telnyx' }, isPending: false }),
}));

vi.mock('../../lib/contacts', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/contacts')>()),
  useContacts: () => ({ data: undefined }),
}));

vi.mock('../../lib/calls', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/calls')>()),
  usePreflight: ({ to }: { to?: string }) => ({
    data: {
      to: to ?? '',
      contact: null,
      decision: { outcome: 'allowed' },
      spend: { outcome: 'ok' },
    },
    isPlaceholderData: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

let Dialer: typeof DialerComponent;

// Loading the dialer's module tree is slow under a full parallel run: not the tests' budget.
beforeAll(async () => {
  ({ Dialer } = await import('./dialer'));
}, 60_000);

afterEach(cleanup);

const callButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Call' });

describe('Dialer and emergency numbers', () => {
  it('enables Call for an ordinary number once the check allows it', () => {
    render(<Dialer initialTo="+12025550123" />);
    expect(callButton().disabled).toBe(false);
    expect(screen.queryByText(EMERGENCY_CALL_MESSAGE)).toBeNull();
  });

  it.each(['911', '112', '+1 911', '+91 112', '988', '933'])(
    'explains why %j cannot be dialed and keeps Call disabled',
    (number) => {
      render(<Dialer initialTo={number} />);
      expect(screen.getByRole('alert').textContent).toBe(EMERGENCY_CALL_MESSAGE);
      expect(callButton().disabled).toBe(true);
    },
  );
});

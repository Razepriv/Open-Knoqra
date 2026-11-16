// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConsentPanel as Panel } from './consent-panel';

const EVIDENCE = 'Agreed by reply to the welcome message.';

vi.mock('../../lib/contact360-queries', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/contact360-queries')>()),
  usePermissions: () => ({
    data: {
      channels: [
        {
          channel: 'sms',
          status: 'granted',
          decision: { outcome: 'allowed', reason: 'granted' },
          evidence: EVIDENCE,
          source: 'manual',
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    error: null,
    isPending: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useSetPermission: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDoNotContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

let ConsentPanel: typeof Panel;

// The first import of the panel (Radix, the UI kit) is slow under jsdom: pay it once, up front.
beforeAll(async () => {
  ({ ConsentPanel } = await import('./consent-panel'));
}, 60_000);

afterEach(() => cleanup());

function renderPanel() {
  render(
    createElement(ConsentPanel, { contactId: 'ct_1', contactName: 'Wen Zhao', readOnly: false }),
  );
  return screen.getByRole('button', { name: 'SMS consent details' });
}

describe('a consent row', () => {
  it('shows the decision and keeps the evidence closed at first', () => {
    const toggle = renderPanel();
    expect(screen.getByText('Consent is on file for messaging.')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const details = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(details).not.toBeNull();
    expect(details?.hidden).toBe(true);
  });

  it('opens the evidence and where it was recorded, then closes again', () => {
    const toggle = renderPanel();
    const details = () => document.getElementById(toggle.getAttribute('aria-controls') ?? '');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details()?.hidden).toBe(false);
    expect(details()?.textContent).toContain(`"${EVIDENCE}"`);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details()?.hidden).toBe(true);
  });
});

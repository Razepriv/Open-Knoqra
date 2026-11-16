// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import type { ConsentChangeDialog as Dialog, PendingChange } from './consent-panel';

const setPermission = vi.fn();
const doNotContact = vi.fn();

vi.mock('../../lib/contact360-queries', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/contact360-queries')>()),
  useSetPermission: () => ({ mutateAsync: setPermission, isPending: false }),
  useDoNotContact: () => ({ mutateAsync: doNotContact, isPending: false }),
}));

const LIFT: PendingChange = { channel: 'sms', action: 'granted', current: 'do_not_contact' };

let ConsentChangeDialog: typeof Dialog;

// The first import of the panel (Radix, the UI kit) is slow under jsdom: pay it once, up front.
beforeAll(async () => {
  ({ ConsentChangeDialog } = await import('./consent-panel'));
}, 60_000);

async function renderDialog(pending: PendingChange) {
  const onClose = vi.fn();
  render(
    createElement(ConsentChangeDialog, {
      contactId: 'ct_1',
      contactName: 'Wen Zhao',
      pending,
      onClose,
      returnFocus: () => null,
    }),
  );
  return { onClose };
}

const reasonField = () => screen.getByRole('textbox', { name: /Reason/ });
const confirm = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Lift and grant consent' }));

beforeEach(() => {
  setPermission.mockReset().mockResolvedValue({});
  doNotContact.mockReset().mockResolvedValue({});
});

afterEach(() => cleanup());

describe('lifting do not contact', () => {
  it('asks for a required reason with a hint and a character count', async () => {
    await renderDialog(LIFT);
    expect(screen.getByRole('dialog', { name: 'Lift do not contact: SMS' })).toBeTruthy();
    const field = reasonField();
    expect(field.hasAttribute('required')).toBe(true);
    expect(field.getAttribute('maxlength')).toBe('500');
    expect(screen.getByText(/How did they give consent again\?/)).toBeTruthy();
    expect(screen.getByText('0 / 500')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'Called back' } });
    expect(screen.getByText('11 / 500')).toBeTruthy();
  });

  it('does not send an empty or short reason and says why on the field', async () => {
    await renderDialog(LIFT);
    confirm();
    expect(await screen.findByText('Add how they gave consent again.')).toBeTruthy();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(reasonField().getAttribute('aria-describedby')).toContain('consent-reason-error');

    fireEvent.change(reasonField(), { target: { value: ' abc ' } });
    expect(reasonField().getAttribute('aria-invalid')).toBeNull();
    confirm();
    expect(await screen.findByText('Use at least 5 characters.')).toBeTruthy();
    expect(setPermission).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason, not evidence, and closes', async () => {
    const { onClose } = await renderDialog(LIFT);
    fireEvent.change(reasonField(), { target: { value: '  Asked to resume texts by email.  ' } });
    confirm();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setPermission).toHaveBeenCalledWith({
      channel: 'sms',
      status: 'granted',
      reason: 'Asked to resume texts by email.',
    });
  });

  it('shows the 422 from the API on the field and keeps the dialog open', async () => {
    setPermission.mockRejectedValue(
      new ApiError(422, 'This channel is marked do not contact.', 'consent_reason_required'),
    );
    const { onClose } = await renderDialog(LIFT);
    fireEvent.change(reasonField(), { target: { value: 'Verbal OK on a call' } });
    confirm();
    expect(await screen.findByText('This channel is marked do not contact.')).toBeTruthy();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows any other failure as the general alert', async () => {
    setPermission.mockRejectedValue(new ApiError(500, 'Boom', 'internal_error'));
    await renderDialog(LIFT);
    fireEvent.change(reasonField(), { target: { value: 'Verbal OK on a call' } });
    confirm();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not save/i);
    expect(reasonField().getAttribute('aria-invalid')).toBeNull();
  });
});

describe('other changes', () => {
  it('keep the optional evidence note, with no reason required', async () => {
    const { onClose } = await renderDialog({
      channel: 'sms',
      action: 'granted',
      current: 'unknown',
    });
    expect(screen.getByRole('dialog', { name: 'Grant consent: SMS' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Reason/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grant consent' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setPermission).toHaveBeenCalledWith({ channel: 'sms', status: 'granted' });
  });

  it('switch to asking for a reason when the server says the channel is do not contact', async () => {
    setPermission.mockRejectedValueOnce(
      new ApiError(422, 'This channel is marked do not contact.', 'consent_reason_required'),
    );
    const { onClose } = await renderDialog({
      channel: 'sms',
      action: 'granted',
      current: 'unknown',
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Evidence (optional)' }), {
      target: { value: 'Replied yes by email' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Grant consent' }));
    expect(await screen.findByText('This channel is marked do not contact.')).toBeTruthy();
    expect((reasonField() as HTMLTextAreaElement).value).toBe('Replied yes by email');
    confirm();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(setPermission).toHaveBeenLastCalledWith({
      channel: 'sms',
      status: 'granted',
      reason: 'Replied yes by email',
    });
  });

  it('do not ask for a reason to revoke a do-not-contact channel', async () => {
    await renderDialog({ channel: 'sms', action: 'revoked', current: 'do_not_contact' });
    expect(screen.getByRole('textbox', { name: 'Evidence (optional)' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Reason/ })).toBeNull();
  });
});

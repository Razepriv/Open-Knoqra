// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import type { DeleteAccountSection as Section } from './delete-account-section';

const deleteAccount = vi.fn();
const navigate = vi.fn();
const clear = vi.fn();
const signOut = vi.fn();

vi.mock('../../lib/account', () => ({ deleteAccount: (p: string) => deleteAccount(p) }));
vi.mock('../../lib/auth', () => ({ authClient: { signOut: () => signOut() } }));
vi.mock('../../lib/theme', () => ({ applyTheme: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear }) }));

let DeleteAccountSection: typeof Section;

// The first import (the UI kit) is slow under jsdom: pay it once, up front.
beforeAll(async () => {
  ({ DeleteAccountSection } = await import('./delete-account-section'));
}, 60_000);

beforeEach(() => {
  deleteAccount.mockReset().mockResolvedValue(undefined);
  navigate.mockReset().mockResolvedValue(undefined);
  clear.mockReset();
  signOut.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => cleanup());

function open() {
  render(createElement(DeleteAccountSection));
  fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
}

const passwordField = () => screen.getByLabelText('Confirm your password');
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

describe('Delete account in Settings', () => {
  it('asks for a second step and the password before deleting', async () => {
    render(createElement(DeleteAccountSection));
    expect(screen.queryByLabelText('Confirm your password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete account…' }));
    confirm();
    expect(await screen.findByText('Enter your password.')).toBeTruthy();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes, clears this browser and goes to sign-in', async () => {
    open();
    fireEvent.change(passwordField(), { target: { value: 'correct-horse-battery-staple' } });
    confirm();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
    expect(deleteAccount).toHaveBeenCalledWith('correct-horse-battery-staple');
    expect(clear).toHaveBeenCalled();
  });

  it('shows a wrong password on the field and stays', async () => {
    deleteAccount.mockRejectedValue(
      new ApiError(400, 'That password is not right.', 'invalid_password'),
    );
    open();
    fireEvent.change(passwordField(), { target: { value: 'wrong' } });
    confirm();
    expect(await screen.findByText('That password is not right.')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('explains a workspace that other people still use', async () => {
    const message =
      'You are the only owner of a workspace other people use. Make another member an owner before you delete your account.';
    deleteAccount.mockRejectedValue(new ApiError(409, message, 'sole_owner_with_members'));
    open();
    fireEvent.change(passwordField(), { target: { value: 'correct-horse-battery-staple' } });
    confirm();
    expect(await screen.findByText(message)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

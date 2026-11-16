import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { deleteAccount } from '../../lib/account';
import { ApiError } from '../../lib/api';
import { authClient } from '../../lib/auth';
import { copy } from '../../lib/auth-errors';
import { applyTheme } from '../../lib/theme';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SettingsSection } from './section';

const FAILED = 'Your account could not be deleted. Try again in a moment.';

/**
 * Deletes the account after a second, explicit step and the password. The server closes a
 * workspace only this user is in and keeps the payment records the law requires (see
 * apps/api/src/account/delete-account.ts); this section only asks and signs the browser out.
 */
export function DeleteAccountSection() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function cancel() {
    setConfirming(false);
    setPassword('');
    setPasswordError(undefined);
    setFormError(null);
  }

  async function submit() {
    if (!password) {
      setPasswordError(copy.passwordRequired);
      return;
    }
    setBusy(true);
    setPasswordError(undefined);
    setFormError(null);
    const typed = password;
    setPassword(''); // never keep the password in state longer than the request needs it
    try {
      await deleteAccount(typed);
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && error.code === 'invalid_password') {
        setPasswordError(error.message);
      } else {
        setFormError(error instanceof ApiError ? error.message : FAILED);
      }
      return;
    }
    // The server ended every session; clear what this browser still holds and leave.
    await authClient.signOut().catch(() => undefined);
    queryClient.clear();
    applyTheme('system');
    await navigate({ to: '/sign-in' });
  }

  return (
    <SettingsSection
      id="delete-account"
      title="Delete account"
      description="Delete your account and sign out everywhere. This can't be undone."
    >
      <div className="flex flex-col gap-4">
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-[color:var(--muted)] leading-snug">
          <li>
            A workspace only you use is closed: its contacts, calls, messages, notes and tasks are
            deleted, and any subscription is cancelled.
          </li>
          <li>In a workspace with another owner, your work stays with the workspace.</li>
          <li>Payment and wallet records are kept as tax law requires, without your name.</li>
        </ul>
        {confirming ? (
          <form
            className="flex max-w-[400px] flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            noValidate
          >
            <Field
              id="delete-account-password"
              name="password"
              type="password"
              label="Confirm your password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={passwordError}
            />
            <FormAlert message={formError} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="danger" disabled={busy} aria-busy={busy}>
                Delete my account
              </Button>
              <Button variant="ghost" disabled={busy} onClick={cancel}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Delete account…
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

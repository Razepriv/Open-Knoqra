import { Button } from '@knoqra/ui';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { Field } from '../components/field';
import { FormAlert } from '../components/form-alert';
import { AuthSkeleton } from '../components/skeletons/auth-skeleton';
import { authClient } from '../lib/auth';
import {
  type AuthErrorLike,
  copy,
  type NewPasswordErrors,
  resetErrorMessage,
  validateNewPassword,
} from '../lib/auth-errors';

export const Route = createFileRoute('/reset-password')({
  // `error` is how Better Auth reports a bad token when it redirects back from the email link.
  validateSearch: (search: Record<string, unknown>): { token?: string; error?: string } => ({
    ...(typeof search.token === 'string' && search.token ? { token: search.token } : {}),
    ...(typeof search.error === 'string' && search.error ? { error: search.error } : {}),
  }),
  pendingComponent: () => <AuthSkeleton route="reset-password" />,
  component: ResetPassword,
});

const linkClass = 'font-medium text-[color:var(--text)] underline underline-offset-4';

function ResetPassword() {
  const search = Route.useSearch();
  // Keep what the link carried, then take it out of the address bar and history (below): the
  // token is a one-time credential and should not survive in the URL, a screenshot or a share.
  const [{ token, error: linkError }] = useState(search);
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: '/reset-password', search: {}, replace: true });
  }, [navigate]);
  const [fieldErrors, setFieldErrors] = useState<NewPasswordErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    const errors = validateNewPassword(password, confirm);
    setFieldErrors(errors);
    setFormError(null);
    if (errors.password || errors.confirm) return;

    setPending(true);
    let error: AuthErrorLike | null;
    try {
      ({ error } = await authClient.resetPassword({ newPassword: password, token }));
    } catch {
      error = { status: 0 };
    }
    if (error) {
      setPending(false);
      setFormError(resetErrorMessage(error));
      return;
    }
    try {
      await navigate({ to: '/sign-in', search: { reset: true }, replace: true });
    } catch {
      setPending(false);
      setFormError(copy.resetFailed);
    }
  }

  const unusable = linkError ? copy.resetLinkInvalid : token ? null : copy.resetLinkIncomplete;

  return (
    <AuthLayout
      headline="A fresh start."
      lede="Choose a new password. You will sign in with it right after."
      eyebrow="Reset password"
      title="Choose a new password"
      footer={
        <Link to="/sign-in" className={linkClass}>
          Back to sign in
        </Link>
      }
    >
      {unusable ? (
        <div className="flex flex-col gap-5">
          <FormAlert message={unusable} />
          <Link to="/forgot-password" className={linkClass}>
            Request a new link
          </Link>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
          <Field
            id="password"
            name="password"
            type="password"
            label="New password"
            autoComplete="new-password"
            hint={copy.passwordRule}
            error={fieldErrors.password}
          />
          <Field
            id="confirm"
            name="confirm"
            type="password"
            label="Confirm new password"
            autoComplete="new-password"
            error={fieldErrors.confirm}
          />
          <FormAlert message={formError} />
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            className="h-12 w-full text-[15px]"
          >
            Set new password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

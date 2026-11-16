import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { CheckboxField } from '../components/checkbox-field';
import { Field } from '../components/field';
import { FormAlert } from '../components/form-alert';
import { AuthSkeleton } from '../components/skeletons/auth-skeleton';
import { safeNext } from '../lib/api';
import { authClient, currentSession } from '../lib/auth';
import { type AuthErrorLike, copy, twoFactorErrorMessage } from '../lib/auth-errors';
import { normalizeCode } from '../lib/two-factor';

export const Route = createFileRoute('/two-factor')({
  // Only a same-origin path survives, as on the sign-in page.
  validateSearch: (search: Record<string, unknown>): { next?: string } => {
    const next = safeNext(search.next);
    return next ? { next } : {};
  },
  beforeLoad: async ({ search }) => {
    // Already signed in (a second tab, a back button): nothing to verify.
    if ((await currentSession()).status !== 'authenticated') return;
    if (search.next) throw redirect({ href: search.next });
    throw redirect({ to: '/' });
  },
  pendingComponent: () => <AuthSkeleton route="two-factor" />,
  component: TwoFactor,
});

type Method = 'totp' | 'backup';

function TwoFactor() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { next } = Route.useSearch();
  const [method, setMethod] = useState<Method>('totp');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const backup = method === 'backup';

  function switchMethod() {
    setMethod(backup ? 'totp' : 'backup');
    setFieldError(undefined);
    setFormError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = normalizeCode(String(form.get('code') ?? ''));
    const trustDevice = form.get('trust') === 'on';
    setFormError(null);
    if (!code) {
      setFieldError(backup ? 'Enter one of your backup codes.' : 'Enter the 6-digit code.');
      return;
    }
    setFieldError(undefined);

    setPending(true);
    let error: AuthErrorLike | null;
    try {
      ({ error } = backup
        ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice })
        : await authClient.twoFactor.verifyTotp({ code, trustDevice }));
    } catch {
      error = { status: 0 };
    }
    if (error) {
      setPending(false); // Stay disabled on success so navigation cannot be double-submitted.
      setFormError(twoFactorErrorMessage(error));
      return;
    }
    try {
      queryClient.clear(); // a new sign-in must not see the previous user's cached data
      if (next) router.history.push(next);
      else await navigate({ to: '/' });
    } catch {
      setPending(false);
      setFormError(copy.signInFailed);
    }
  }

  return (
    <AuthLayout
      headline="One more step."
      lede="Your password was right. Confirm it is really you to finish signing in."
      eyebrow="Two-factor"
      title="Two-factor authentication"
      footer={
        <>
          Wrong account?{' '}
          <Link
            to="/sign-in"
            search={next ? { next } : {}}
            className="font-medium text-[color:var(--text)] underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        {/* Remount on switch so the other field starts empty. */}
        <Field
          key={method}
          id="code"
          name="code"
          type="text"
          label={backup ? 'Backup code' : 'Authentication code'}
          hint={
            backup
              ? 'Each backup code works once.'
              : 'The 6-digit code from your authenticator app.'
          }
          autoComplete="one-time-code"
          inputMode={backup ? 'text' : 'numeric'}
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          error={fieldError}
        />
        <CheckboxField id="trust" name="trust" label="Trust this device for 30 days" />
        <FormAlert message={formError} />
        <Button
          type="submit"
          variant="primary"
          disabled={pending}
          aria-busy={pending}
          className="h-12 w-full text-[15px]"
        >
          Verify
        </Button>
        <button
          type="button"
          onClick={switchMethod}
          className="cursor-pointer self-start text-[14px] text-[color:var(--muted)] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
        >
          {backup ? 'Use an authentication code instead' : 'Use a backup code instead'}
        </button>
      </form>
    </AuthLayout>
  );
}

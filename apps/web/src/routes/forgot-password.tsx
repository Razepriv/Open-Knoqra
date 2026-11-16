import { Button } from '@knoqra/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { MailCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { Field } from '../components/field';
import { FormAlert } from '../components/form-alert';
import { AuthSkeleton } from '../components/skeletons/auth-skeleton';
import { authClient } from '../lib/auth';
import { copy, looksLikeEmail } from '../lib/auth-errors';

export const Route = createFileRoute('/forgot-password')({
  pendingComponent: () => <AuthSkeleton route="forgot-password" />,
  component: ForgotPassword,
});

const linkClass = 'font-medium text-[color:var(--text)] underline underline-offset-4';

function ForgotPassword() {
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    setFormError(null);
    if (!looksLikeEmail(email)) {
      setEmailError(copy.emailInvalid);
      return;
    }
    setEmailError(undefined);
    setPending(true);
    try {
      const { error } = await authClient.requestPasswordReset({
        email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      // The server answers the same whether or not the address has an account. Only a rate limit
      // or an outage is worth telling the user about; anything else gets the neutral answer.
      if (error?.status === 429) setFormError(copy.tooManyAttempts);
      else if (error && (error.status === undefined || error.status >= 500)) {
        setFormError(copy.resetRequestFailed);
      } else setSent(true);
    } catch {
      setFormError(copy.resetRequestFailed);
    }
    setPending(false);
  }

  return (
    <AuthLayout
      headline="Locked out? It happens."
      lede="Tell us your email and we will send a link to choose a new password."
      eyebrow="Reset password"
      title="Forgot your password?"
      footer={
        <>
          Remembered it?{' '}
          <Link to="/sign-in" className={linkClass}>
            Back to sign in
          </Link>
        </>
      }
    >
      {sent ? (
        <div role="status" className="flex flex-col gap-4">
          <MailCheck size={28} strokeWidth={1.5} aria-hidden="true" />
          <p className="text-[15px] leading-relaxed">{copy.resetSent}</p>
          <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
            The link expires soon. Check your spam folder if it does not arrive.
          </p>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
          <Field
            id="email"
            name="email"
            type="email"
            label="Email"
            autoComplete="email"
            placeholder="you@company.com"
            error={emailError}
          />
          <FormAlert message={formError} />
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            className="h-12 w-full text-[15px]"
          >
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { Field } from '../components/field';
import { FormAlert } from '../components/form-alert';
import { AuthSkeleton } from '../components/skeletons/auth-skeleton';
import { useToast } from '../components/use-toast';
import { safeNext } from '../lib/api';
import { authClient, currentSession } from '../lib/auth';
import { type AuthErrorLike, copy, looksLikeEmail, signInErrorMessage } from '../lib/auth-errors';
import { needsTwoFactor } from '../lib/two-factor';

export const Route = createFileRoute('/sign-in')({
  // Only a same-origin path survives, so `?next=` cannot be used as an open redirect.
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string; expired?: true; reset?: true } => {
    const next = safeNext(search.next);
    return {
      ...(next ? { next } : {}),
      ...(search.expired === true ? { expired: true } : {}),
      // Set by the reset-password page once the new password is saved.
      ...(search.reset === true ? { reset: true } : {}),
    };
  },
  beforeLoad: async ({ search }) => {
    // `expired` means the API just answered 401, so a session check that still says signed in is
    // out of sync with it. Show the form rather than bounce back and loop.
    if (search.expired) return;
    // Unreachable falls through: the form still renders and a failed submit explains itself.
    if ((await currentSession()).status !== 'authenticated') return;
    if (search.next) throw redirect({ href: search.next });
    throw redirect({ to: '/' });
  },
  pendingComponent: () => <AuthSkeleton route="sign-in" />,
  component: SignIn,
});

interface FieldErrors {
  email?: string;
  password?: string;
}

function SignIn() {
  const navigate = useNavigate();
  const router = useRouter();
  const { next, expired, reset } = Route.useSearch();
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { show, toast } = useToast();

  // Arriving from a finished password reset: say so once, then drop the one-off flag from the
  // address so a reload or a shared link does not repeat it.
  useEffect(() => {
    if (!reset) return;
    show(copy.resetDone);
    void navigate({
      to: '/sign-in',
      search: (prev) => ({ ...prev, reset: undefined }),
      replace: true,
    });
  }, [reset, show, navigate]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    const errors: FieldErrors = {};
    if (!looksLikeEmail(email)) errors.email = copy.emailInvalid;
    if (!password) errors.password = copy.passwordRequired;
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    let error: AuthErrorLike | null;
    let data: unknown;
    try {
      ({ data, error } = await authClient.signIn.email({ email, password }));
    } catch {
      error = { status: 0 }; // Network failure: show the generic retry copy.
    }
    if (error) {
      setPending(false); // Stay disabled on success so navigation cannot be double-submitted.
      setFormError(signInErrorMessage(error));
      return;
    }
    try {
      if (needsTwoFactor(data)) {
        // Password accepted, second factor pending: no session exists until it is verified.
        await navigate({ to: '/two-factor', search: next ? { next } : {} });
        return;
      }
      queryClient.clear(); // a new sign-in must not see the previous user's cached data
      if (next) router.history.push(next);
      else await navigate({ to: '/' });
    } catch {
      setPending(false); // Signed in but could not leave the page: let them retry.
      setFormError(copy.signInFailed);
    }
  }

  return (
    <AuthLayout
      headline="Welcome back."
      lede="Your calls, texts and contacts are right where you left them."
      eyebrow="Sign in"
      title="Good to see you"
      footer={
        <>
          New to KNOQRA?{' '}
          <Link
            to="/sign-up"
            className="font-medium text-[color:var(--text)] underline underline-offset-4"
          >
            Create an account
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <FormAlert message={expired ? copy.sessionExpired : null} tone="notice" />
        <Field
          id="email"
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          placeholder="you@company.com"
          error={fieldErrors.email}
        />
        <Field
          id="password"
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          error={fieldErrors.password}
        />
        <Link
          to="/forgot-password"
          className="-mt-2 self-start text-[14px] text-[color:var(--muted)] underline underline-offset-4"
        >
          Forgot password?
        </Link>
        <FormAlert message={formError} />
        <Button
          type="submit"
          variant="primary"
          disabled={pending}
          aria-busy={pending}
          className="h-12 w-full text-[15px]"
        >
          Sign in
        </Button>
      </form>
      {toast}
    </AuthLayout>
  );
}

import { BRAND_URL } from '@knoqra/brand';
import { Button } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { AuthLayout } from '../components/auth-layout';
import { CheckboxField } from '../components/checkbox-field';
import { Field } from '../components/field';
import { FormAlert } from '../components/form-alert';
import { AuthSkeleton } from '../components/skeletons/auth-skeleton';
import { authClient, currentSession } from '../lib/auth';
import {
  type AuthErrorLike,
  copy,
  displayNameError,
  looksLikeEmail,
  MIN_PASSWORD_LENGTH,
  signUpErrorField,
  signUpErrorMessage,
} from '../lib/auth-errors';

export const Route = createFileRoute('/sign-up')({
  beforeLoad: async () => {
    // Unreachable falls through: the form still renders and a failed submit explains itself.
    if ((await currentSession()).status === 'authenticated') throw redirect({ to: '/' });
  },
  pendingComponent: () => <AuthSkeleton route="sign-up" />,
  component: SignUp,
});

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  acceptTerms?: string;
}

const TERMS_URL = `${BRAND_URL}/terms/`;
const PRIVACY_URL = `${BRAND_URL}/privacy/`;
const ACCEPT_TERMS_REQUIRED =
  'Agree to the Terms of Service and Privacy Policy to create an account.';

function validate(
  name: string,
  email: string,
  password: string,
  acceptTerms: boolean,
): FieldErrors {
  const errors: FieldErrors = {};
  const nameError = displayNameError(name);
  if (nameError) errors.name = nameError;
  if (!looksLikeEmail(email)) errors.email = copy.emailInvalid;
  if (password.length < MIN_PASSWORD_LENGTH) errors.password = copy.passwordTooShort;
  if (!acceptTerms) errors.acceptTerms = ACCEPT_TERMS_REQUIRED;
  return errors;
}

function SignUp() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    // Off unless ticked. The API stores the choice with its time and sends the welcome email.
    const newsletter = form.get('newsletter') === 'on';
    // An explicit consent action (India's DPDP Act): the API records when and which version.
    const acceptTerms = form.get('acceptTerms') === 'on';

    const errors = validate(name, email, password, acceptTerms);
    setFieldErrors(errors);
    setFormError(null);
    if (Object.keys(errors).length > 0) return;

    setPending(true);
    let error: AuthErrorLike | null;
    try {
      // `newsletter` is not a user field: the API's sign-up hook reads it from the body (auth.ts).
      const body = { name, email, password, newsletter, acceptTerms };
      ({ error } = await authClient.signUp.email(body));
    } catch {
      error = { status: 0 }; // Network failure: show the generic retry copy.
    }
    if (error) {
      setPending(false); // Stay disabled on success so navigation cannot be double-submitted.
      const message = signUpErrorMessage(error);
      const field = signUpErrorField(message);
      if (field) setFieldErrors({ [field]: message });
      else setFormError(message);
      return;
    }
    try {
      queryClient.clear(); // a new sign-in must not see the previous user's cached data
      await navigate({ to: '/' });
    } catch {
      setPending(false); // The account exists but we could not leave the page: let them retry.
      setFormError(copy.signUpFailed);
    }
  }

  return (
    <AuthLayout
      headline="Make your first call in five minutes."
      lede="Calls, texts and WhatsApp for your whole team, with every contact's history in one calm place."
      eyebrow="Create your workspace"
      title="Start with your name"
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/sign-in"
            className="font-medium text-[color:var(--text)] underline underline-offset-4"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field
          id="name"
          name="name"
          label="Name"
          autoComplete="name"
          placeholder="Ana Silva"
          error={fieldErrors.name}
        />
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
          autoComplete="new-password"
          hint={copy.passwordRule}
          error={fieldErrors.password}
        />
        <CheckboxField
          id="acceptTerms"
          name="acceptTerms"
          required
          label={
            <>
              I agree to the{' '}
              <a href={TERMS_URL} target="_blank" rel="noreferrer" className="underline">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="underline">
                Privacy Policy
              </a>
            </>
          }
          error={fieldErrors.acceptTerms}
          defaultChecked={false}
        />
        <CheckboxField
          id="newsletter"
          name="newsletter"
          label="Email me product news and new blog posts"
          hint="A few emails a month at most. Unsubscribe in one click, or turn it off in Settings."
          defaultChecked={false}
        />
        <FormAlert message={formError} />
        <Button
          type="submit"
          variant="primary"
          disabled={pending}
          aria-busy={pending}
          className="h-12 w-full text-[15px]"
        >
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

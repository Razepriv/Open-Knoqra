import { Button, ButtonLink } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../lib/api';
import { authClient } from '../../lib/auth';
import {
  LICENSE_ISSUER_URL,
  type LicenseStatus,
  tidyLicenseKey,
  useEnterLicense,
} from '../../lib/license';
import { AuthLayout } from '../auth-layout';
import { FormAlert } from '../form-alert';
import { TextareaField } from '../textarea-field';

/** The API's longest key (LICENSE_MAX_LENGTH in @knoqra/core). */
const KEY_MAX = 1024;

function saveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'Only an owner or admin of a workspace on this server can enter the key.';
  }
  if (error instanceof ApiError && error.status === 400) return error.message;
  return 'We could not save the key. Try again in a moment.';
}

/**
 * A self-hosted KNOQRA without a valid license key shows this instead of the Desk. The key is
 * free: KNOQRA's cloud issues it to anyone who signs in with GitHub and has starred the
 * repository. This instance checks it offline.
 */
export function LicenseGate({ status, email }: { status: LicenseStatus; email: string }) {
  const save = useEnterLicense();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [signingOut, setSigningOut] = useState(false);
  // A key that is present but refused (not just missing) explains itself up front.
  const problem = status.reason && status.reason !== 'missing' ? status.message : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const tidy = tidyLicenseKey(key);
    if (!tidy) {
      setFieldError('Paste the key from the license page.');
      return;
    }
    setFieldError(undefined);
    save.mutate(tidy, {
      onSuccess: (next) => {
        // Everything the Desk asked for while locked was refused: ask again.
        if (next.licensed) void queryClient.invalidateQueries();
      },
    });
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await authClient.signOut();
      queryClient.clear();
      await navigate({ to: '/sign-in' });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <AuthLayout
      headline="Your own KNOQRA, on your own server."
      lede="This is a self-hosted KNOQRA. It is free and open source, with no limits. A license key unlocks it: KNOQRA issues one to anyone who stars the project on GitHub."
      eyebrow="Self-hosted"
      title="Enter your license key"
      footer={
        <>
          {`Signed in as ${email}. `}
          <button
            type="button"
            className="cursor-pointer underline underline-offset-4 disabled:opacity-50"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            Sign out
          </button>
        </>
      }
    >
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[14px] leading-relaxed">
        <li>Star the KNOQRA repository on GitHub.</li>
        <li>Sign in with GitHub on the license page. It shows your key once.</li>
        <li>Paste the key here.</li>
      </ol>
      <ButtonLink
        variant="ghost"
        href={LICENSE_ISSUER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start"
      >
        Get a license key
        <ExternalLink size={15} strokeWidth={1.75} aria-hidden="true" />
      </ButtonLink>
      <FormAlert message={problem} />
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextareaField
          id="license-key"
          label="License key"
          autoComplete="off"
          spellCheck={false}
          maxLength={KEY_MAX + 64}
          placeholder="KNOQRA-LICENSE-1.…"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          hint="Checked on this server, offline. It holds your GitHub login and the date it was issued."
          error={fieldError}
          className="font-[family-name:var(--font-mono)] text-[13px]"
        />
        <FormAlert message={save.isError ? saveError(save.error) : null} />
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending}
          aria-busy={save.isPending}
        >
          {save.isPending ? 'Checking…' : 'Unlock KNOQRA'}
        </Button>
      </form>
    </AuthLayout>
  );
}

import { Button, Reveal } from '@knoqra/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { authClient } from '../../lib/auth';
import {
  type AuthErrorLike,
  copy,
  securityErrorMessage,
  twoFactorErrorMessage,
} from '../../lib/auth-errors';
import { sessionsKey } from '../../lib/sessions';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { SecurityBodySkeleton } from '../skeletons/settings-skeleton';
import { QueryStatePanel } from '../states/state-panel';
import { useToast } from '../use-toast';
import { BackupCodes } from './backup-codes';
import { SettingsSection } from './section';
import { TotpSetup } from './totp-setup';

/** Where the two-factor flow is. Secrets and codes live in this state only, in memory. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'setup'; uri: string; codes: readonly string[] }
  | { kind: 'codes'; codes: readonly string[] };

type PasswordAction = 'enable' | 'disable' | 'regenerate';

async function asErrorLike(run: () => Promise<{ error: AuthErrorLike | null }>) {
  try {
    return (await run()).error;
  } catch {
    return { status: 0 } satisfies AuthErrorLike;
  }
}

/** Read out by screen readers when the flow moves on, since focus alone does not say why. */
const PHASE_ANNOUNCEMENT: Record<Phase['kind'], string> = {
  idle: '',
  setup: 'Scan the code with your authenticator app, then enter the code it shows.',
  codes: 'Two-factor is on. Your backup codes are shown below. Save them now.',
};

/** Two-factor sign-in: set up with a password check, verify, backup codes, and turn off. */
export function SecuritySection() {
  const session = authClient.useSession();
  const queryClient = useQueryClient();
  const { show, toast } = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const enabled = session.data?.user.twoFactorEnabled === true;
  const announcement = PHASE_ANNOUNCEMENT[phase.kind];

  async function run(action: PasswordAction, password: string) {
    setBusy(true);
    setFormError(null);
    setPasswordError(undefined);
    let error: AuthErrorLike | null = null;
    if (action === 'enable') {
      error = await asErrorLike(async () => {
        const { data, error: failure } = await authClient.twoFactor.enable({ password });
        if (data && 'totpURI' in data)
          setPhase({ kind: 'setup', uri: data.totpURI, codes: data.backupCodes });
        return { error: failure };
      });
    } else if (action === 'regenerate') {
      error = await asErrorLike(async () => {
        const { data, error: failure } = await authClient.twoFactor.generateBackupCodes({
          password,
        });
        if (data) setPhase({ kind: 'codes', codes: data.backupCodes });
        return { error: failure };
      });
    } else {
      error = await asErrorLike(async () => {
        const result = await authClient.twoFactor.disable({ password });
        if (!result.error) {
          show('Two-factor turned off');
          // Better Auth rotates the session when two-factor is turned off.
          void queryClient.invalidateQueries({ queryKey: sessionsKey });
        }
        return { error: result.error };
      });
    }
    setBusy(false);
    if (!error) return;
    const message = securityErrorMessage(error);
    if (error.code === 'INVALID_PASSWORD') setPasswordError(message);
    else setFormError(message);
  }

  async function verify(code: string) {
    if (phase.kind !== 'setup') return;
    setBusy(true);
    setFormError(null);
    const error = await asErrorLike(() => authClient.twoFactor.verifyTotp({ code }));
    setBusy(false);
    if (error) {
      setFormError(twoFactorErrorMessage(error));
      return;
    }
    // Verifying the first code rotates the session, so the device list needs a refetch.
    void queryClient.invalidateQueries({ queryKey: sessionsKey });
    setPhase({ kind: 'codes', codes: phase.codes });
  }

  return (
    <SettingsSection
      id="security"
      title="Security"
      description="Add a code from your phone to your password, so a stolen password alone cannot sign in."
    >
      {/* Always mounted: a live region only announces changes made after it exists. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <Reveal loading={session.isPending}>
        {session.isPending ? (
          <SecurityBodySkeleton label="Loading security settings" />
        ) : session.error && !session.data ? (
          <QueryStatePanel
            error={session.error}
            onRetry={() => void session.refetch()}
            retrying={session.isRefetching}
            subject="your security settings"
            headingLevel={3}
          />
        ) : phase.kind === 'setup' ? (
          <TotpSetup
            uri={phase.uri}
            pending={busy}
            error={formError}
            onVerify={verify}
            onCancel={() => {
              setPhase({ kind: 'idle' });
              setFormError(null);
            }}
          />
        ) : phase.kind === 'codes' ? (
          <BackupCodes
            codes={phase.codes}
            onNotice={show}
            onDone={() => {
              setPhase({ kind: 'idle' });
              void session.refetch();
            }}
          />
        ) : (
          <PasswordGate
            enabled={enabled}
            busy={busy}
            passwordError={passwordError}
            formError={formError}
            onRun={run}
          />
        )}
      </Reveal>
      {toast}
    </SettingsSection>
  );
}

interface PasswordGateProps {
  enabled: boolean;
  busy: boolean;
  passwordError: string | undefined;
  formError: string | null;
  onRun: (action: PasswordAction, password: string) => void;
}

/** Every change to two-factor asks for the password again, even though the user is signed in. */
function PasswordGate({ enabled, busy, passwordError, formError, onRun }: PasswordGateProps) {
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();
  const StatusIcon = enabled ? ShieldCheck : ShieldOff;

  function submit(action: PasswordAction) {
    if (!password) {
      setLocalError(copy.passwordRequired);
      return;
    }
    setLocalError(undefined);
    onRun(action, password);
    setPassword(''); // never keep the password in state longer than the request needs it
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <StatusIcon size={22} strokeWidth={1.5} aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-[15px] leading-none">
            {enabled ? 'Two-factor is on' : 'Two-factor is off'}
          </p>
          <p className="text-[13px] text-[color:var(--muted)] leading-snug">
            {enabled
              ? 'Signing in asks for a code from your authenticator app.'
              : 'Signing in needs only your password.'}
          </p>
        </div>
      </div>
      <form
        className="flex max-w-[400px] flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit(enabled ? 'disable' : 'enable');
        }}
        noValidate
      >
        <Field
          id="security-password"
          name="password"
          type="password"
          label="Confirm your password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={localError ?? passwordError}
        />
        <FormAlert message={formError} />
        <div className="flex flex-wrap gap-2">
          {enabled ? (
            <>
              <Button type="submit" variant="danger" disabled={busy} aria-busy={busy}>
                Turn off two-factor
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => submit('regenerate')}>
                New backup codes
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
              Set up two-factor
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

import { Button } from '@knoqra/ui';
import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../../lib/api';
import { formatPhone } from '../../lib/contacts';
import { isFakeProvider, type Setup } from '../../lib/setup';
import { useVoiceConnection, useVoiceStatus } from '../../lib/voice-connection';
import { FormAlert } from '../form-alert';
import { ConnectStepSkeleton } from './setup-skeletons';
import { TelnyxConnectForm } from './telnyx-connect-form';

const MANAGER_ROLES = new Set(['owner', 'admin']);

function CredentialCheck({ setup }: { setup: Setup }) {
  const check = setup.checks.find((item) => item.id === 'credential');
  if (!check) return null;
  const Icon =
    check.status === 'pass' ? CircleCheck : check.status === 'fail' ? CircleAlert : Clock;
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-2xl bg-[color:var(--cell)] px-4 py-3 text-[14px] leading-snug"
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="mt-[2px] shrink-0" />
      <span>
        <span className="font-semibold">{check.title}</span>
        {`: ${check.detail}`}
      </span>
    </p>
  );
}

/** Step 1: save the Telnyx key, connection id and caller id, then show how Telnyx answered. */
export function ConnectStep({ setup, onDone }: { setup: Setup; onDone: () => void }) {
  const me = useMe();
  const connection = useVoiceConnection();
  const status = useVoiceStatus();
  const [replacing, setReplacing] = useState(false);
  const fake = isFakeProvider(setup);

  if (me.isPending || connection.isPending) return <ConnectStepSkeleton />;
  // A failed refetch keeps what was loaded; only a first load with nothing to show is an error.
  if (me.data === undefined || connection.data === undefined) {
    return <FormAlert message="We could not load your Telnyx connection. Try again." />;
  }
  const canManage = MANAGER_ROLES.has(me.data.organization.role);
  if (!canManage) {
    return (
      <p className="max-w-[46ch] text-[15px] text-[color:var(--muted)] leading-relaxed">
        Ask an owner or admin to connect Telnyx.
      </p>
    );
  }

  const saved = connection.data;
  if (status.data?.provider === 'plivo') {
    // This step's form is Telnyx's; another provider is managed in Settings › Connectors.
    return (
      <div className="flex max-w-[440px] flex-col gap-4">
        <p className="text-[15px] leading-relaxed">
          This workspace is connected to Plivo. Change it in Settings › Connectors.
        </p>
        <CredentialCheck setup={setup} />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onDone}>
            Continue
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {fake ? (
        <p className="max-w-[52ch] text-[13px] text-[color:var(--muted)] leading-snug">
          Development uses the fake provider, so calls work without a live key.
        </p>
      ) : null}
      {saved && !replacing ? (
        <div className="flex max-w-[440px] flex-col gap-4">
          <dl className="flex flex-col gap-1 text-[14px]">
            <div className="flex gap-2">
              <dt className="text-[color:var(--muted)]">Key ending</dt>
              <dd className="font-[family-name:var(--font-mono)]">{`••••${saved.apiKeyLast4}`}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[color:var(--muted)]">Connection</dt>
              <dd className="font-[family-name:var(--font-mono)]">{saved.connectionId ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[color:var(--muted)]">Caller id</dt>
              <dd className="font-[family-name:var(--font-mono)]">
                {saved.callerIdE164 ? formatPhone(saved.callerIdE164) : '—'}
              </dd>
            </div>
          </dl>
          <CredentialCheck setup={setup} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onDone}>
              Continue
            </Button>
            <Button variant="ghost" onClick={() => setReplacing(true)}>
              Replace key
            </Button>
          </div>
        </div>
      ) : (
        <TelnyxConnectForm onSaved={() => setReplacing(false)} />
      )}
    </div>
  );
}

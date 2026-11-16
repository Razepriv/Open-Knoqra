import { Button, Reveal, StatusDot } from '@knoqra/ui';
import { type FormEvent, useState } from 'react';
import type { Me } from '../../lib/api';
import {
  type ConnectInput,
  type ConnectorConnection,
  type ConnectorId,
  type ConnectorProvider,
  capabilityLine,
  checkCopy,
  connectorErrorCopy,
  useCheckConnector,
  useConnectors,
  useDisconnectConnector,
  useSaveConnector,
} from '../../lib/connectors';
import { formatPhone } from '../../lib/contacts';
import { dialTarget } from '../../lib/dial';
import { formatDate } from '../../lib/format';
import { isOwnerOrAdmin } from '../../lib/wallet-form';
import { DialogCancel, DialogShell } from '../dialog-shell';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { QueryStatePanel } from '../states/state-panel';
import { useToast } from '../use-toast';
import { SettingsSection } from './section';
import { CONNECTORS_SECTION as SECTION, VoiceSkeleton } from './voice-skeleton';

/**
 * Settings › Connectors: the telephony providers this workspace can connect, one at a time. Each
 * card shows its status; owners and admins connect, update and disconnect. Secrets are
 * write-only: after a save the field is cleared and only the last four characters come back.
 */
export function ConnectorsSection({ me }: { me: Me }) {
  const connectors = useConnectors();
  const manager = isOwnerOrAdmin(me.organization.role);
  return (
    <SettingsSection {...SECTION}>
      <Reveal loading={connectors.isPending}>
        {connectors.isPending ? (
          <VoiceSkeleton />
        ) : connectors.data ? (
          <div className="flex flex-col gap-4">
            {connectors.data.providers.map((provider) => (
              <ConnectorCard
                key={provider.id}
                provider={provider}
                connection={connectors.data.connection}
                manager={manager}
              />
            ))}
            {manager ? null : (
              <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
                Only owners and admins can change connectors.
              </p>
            )}
          </div>
        ) : (
          <QueryStatePanel
            error={connectors.error}
            onRetry={() => void connectors.refetch()}
            retrying={connectors.isFetching}
            subject="the connectors"
            headingLevel={3}
          />
        )}
      </Reveal>
    </SettingsSection>
  );
}

function ConnectorCard({
  provider,
  connection,
  manager,
}: {
  provider: ConnectorProvider;
  connection: ConnectorConnection | null;
  manager: boolean;
}) {
  const mine = connection?.provider === provider.id ? connection : null;
  const otherConnected = connection !== null && mine === null;
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const check = useCheckConnector();
  const { show, toast } = useToast();
  const headingId = `connector-${provider.id}`;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-[18px] bg-[color:var(--cell)] px-4 py-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="font-medium text-[16px] leading-none">
          {provider.label}
        </h3>
        <StatusDot
          status={mine ? (mine.check?.status === 'auth_failed' ? 'bad' : 'ok') : 'none'}
          label={mine ? `Connected to ${provider.label}` : 'Not connected'}
        />
      </header>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-snug tracking-[.04em]">
        {capabilityLine(provider.capabilities)}
      </p>
      {provider.liveVerified ? null : (
        <p className="text-[13px] text-[color:var(--muted)] leading-snug">
          Built from {provider.label}’s documentation and not yet tested on a live account. Try it
          on a test account first.
        </p>
      )}
      {mine ? <ConnectedDetails provider={provider} connection={mine} /> : null}
      {otherConnected ? (
        <p className="text-[13px] text-[color:var(--muted)] leading-snug">
          This workspace uses another provider. Disconnect it to use {provider.label}.
        </p>
      ) : null}
      {manager && !otherConnected ? (
        editing ? (
          <ConnectForm
            provider={provider}
            connection={mine}
            onDone={(message) => {
              setEditing(false);
              if (message) show(message);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={mine ? 'ghost' : 'primary'}
              className="h-11 px-6"
              onClick={() => setEditing(true)}
            >
              {mine ? `Update ${provider.label}` : `Connect ${provider.label}`}
            </Button>
            {mine ? (
              <>
                <Button
                  variant="ghost"
                  className="h-11 px-6"
                  disabled={check.isPending}
                  aria-busy={check.isPending}
                  onClick={() =>
                    check.mutate(undefined, {
                      onSuccess: () => show('Connection checked'),
                    })
                  }
                >
                  Check now
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 px-6"
                  onClick={() => setDisconnecting(true)}
                >
                  {`Disconnect ${provider.label}`}
                </Button>
              </>
            ) : null}
          </div>
        )
      ) : null}
      <FormAlert message={check.isError ? connectorErrorCopy(check.error) : null} />
      {disconnecting ? (
        <DisconnectDialog
          provider={provider}
          onClose={() => setDisconnecting(false)}
          onDisconnected={() => show(`${provider.label} disconnected`)}
        />
      ) : null}
      {toast}
    </section>
  );
}

function ConnectedDetails({
  provider,
  connection,
}: {
  provider: ConnectorProvider;
  connection: ConnectorConnection;
}) {
  const facts = [
    connection.callerIdE164 ? `Caller id ${formatPhone(connection.callerIdE164)}` : null,
    connection.check
      ? `${checkCopy(connection.check)} ${formatDate(connection.check.checkedAt)}`
      : checkCopy(null),
    `Updated ${formatDate(connection.updatedAt)}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-3">
      <p className="font-[family-name:var(--font-mono)] font-medium text-[12px] leading-snug">
        {`${provider.id === 'plivo' ? 'Auth token' : 'Key'} ending ••••${connection.last4}`}
      </p>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-snug tracking-[.04em]">
        {facts.join(' · ')}
      </p>
      <WebhookUrls provider={provider} connection={connection} />
    </div>
  );
}

/** Where the provider must post: shown once connected, with a copy button for each URL. */
function WebhookUrls({
  provider,
  connection,
}: {
  provider: ConnectorProvider;
  connection: ConnectorConnection;
}) {
  const { webhook } = connection;
  const prefix = webhook.absolute ? '' : 'On your API domain: ';
  const rows =
    provider.id === 'plivo'
      ? [
          { label: 'Application answer URL (POST)', value: webhook.answer ?? '' },
          { label: 'Application hangup URL (POST)', value: webhook.events },
        ]
      : [{ label: 'Connection webhook URL', value: webhook.events }];
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <span className="text-[13px] text-[color:var(--muted)]">{row.label}</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all font-[family-name:var(--font-mono)] text-[12px]">
              {`${prefix}${row.value}`}
            </code>
            <CopyButton value={row.value} label={row.label} />
          </div>
        </div>
      ))}
      {provider.id === 'telnyx' && !webhook.ownKey ? (
        <p className="text-[13px] text-[color:var(--muted)] leading-snug">
          Add your account’s webhook public key to give this connection its own webhook URL. Until
          then it uses the platform URL above.
        </p>
      ) : null}
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      className="h-8 px-3 text-[12px]"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

type Values = Record<string, string>;

/** The provider's fields, as the API describes them. Secret fields are password inputs, never prefilled. */
function ConnectForm({
  provider,
  connection,
  onDone,
}: {
  provider: ConnectorProvider;
  connection: ConnectorConnection | null;
  onDone: (message: string | null) => void;
}) {
  const save = useSaveConnector();
  const [values, setValues] = useState<Values>(() => initialValues(provider, connection));
  const [errors, setErrors] = useState<Values>({});
  // Kept here because the mutation is reset once it settles (its variables hold the secret).
  const [saveError, setSaveError] = useState<unknown>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validate(provider, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaveError(null);
    save.mutate(toInput(provider.id, values), {
      onSettled: () => {
        // The secret never stays in the page, or in the mutation cache, once the server has it.
        setValues((v) => clearSecrets(provider, v));
        save.reset();
      },
      onError: (error) => setSaveError(error),
      onSuccess: () => onDone(`${provider.label} connected`),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {provider.fields.map((field) => (
        <Field
          key={field.name}
          id={`connector-${provider.id}-${field.name}`}
          label={field.required ? field.label : `${field.label} (optional)`}
          type={field.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          inputMode={field.name === 'callerIdE164' ? 'tel' : undefined}
          value={values[field.name] ?? ''}
          placeholder={field.secret && connection ? 'Paste it again to save changes' : undefined}
          onChange={(event) => setValues((v) => ({ ...v, [field.name]: event.target.value }))}
          hint={field.hint}
          error={errors[field.name]}
        />
      ))}
      <FormAlert message={saveError ? connectorErrorCopy(saveError) : null} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending}
          aria-busy={save.isPending}
          className="h-11 px-6"
        >
          Save connection
        </Button>
        <Button variant="ghost" className="h-11 px-6" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function initialValues(
  provider: ConnectorProvider,
  connection: ConnectorConnection | null,
): Values {
  const values: Values = {};
  for (const field of provider.fields) values[field.name] = '';
  if (!connection) return values;
  if (provider.id === 'telnyx') values.connectionId = connection.connectionId ?? '';
  if (provider.id === 'plivo') {
    values.authId = connection.accountId ?? '';
    values.appId = connection.connectionId ?? '';
  }
  values.callerIdE164 = connection.callerIdE164 ? formatPhone(connection.callerIdE164) : '';
  return values;
}

function clearSecrets(provider: ConnectorProvider, values: Values): Values {
  const next = { ...values };
  for (const field of provider.fields) if (field.secret) next[field.name] = '';
  return next;
}

/** "API key" stays, "Caller id" becomes "caller id": a label as it reads mid-sentence. */
const inSentence = (label: string): string =>
  /^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;

export function validate(provider: ConnectorProvider, values: Values): Values {
  const errors: Values = {};
  for (const field of provider.fields) {
    const value = (values[field.name] ?? '').trim();
    if (field.required && value === '')
      errors[field.name] = `Enter the ${inSentence(field.label)}.`;
    else if (field.secret && /\s/.test(values[field.name] ?? '')) {
      errors[field.name] = 'Paste it without spaces.';
    }
  }
  if (!errors.callerIdE164 && dialTarget(values.callerIdE164 ?? '') === null) {
    errors.callerIdE164 = 'Enter a full number with country code, like +1 202 555 0123.';
  }
  return errors;
}

export function toInput(provider: ConnectorId, values: Values): ConnectInput {
  const callerIdE164 = dialTarget(values.callerIdE164 ?? '') ?? values.callerIdE164 ?? '';
  if (provider === 'plivo') {
    return {
      provider,
      body: {
        authId: (values.authId ?? '').trim(),
        authToken: values.authToken ?? '',
        appId: (values.appId ?? '').trim(),
        callerIdE164,
      },
    };
  }
  const publicKey = (values.webhookPublicKey ?? '').trim();
  return {
    provider,
    body: {
      apiKey: values.apiKey ?? '',
      connectionId: (values.connectionId ?? '').trim(),
      callerIdE164,
      ...(publicKey === '' ? {} : { webhookPublicKey: publicKey }),
    },
  };
}

function DisconnectDialog({
  provider,
  onClose,
  onDisconnected,
}: {
  provider: ConnectorProvider;
  onClose: () => void;
  onDisconnected: () => void;
}) {
  const disconnect = useDisconnectConnector();
  return (
    <DialogShell
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Disconnect ${provider.label}?`}
      description="KNOQRA deletes the stored key and stops placing calls through this account. Calls in progress are not affected. You can connect again at any time."
      size="sm"
    >
      <div className="flex flex-col gap-4">
        <FormAlert message={disconnect.isError ? connectorErrorCopy(disconnect.error) : null} />
        <div className="flex justify-end gap-2">
          <DialogCancel />
          <Button
            variant="danger"
            disabled={disconnect.isPending}
            aria-busy={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(provider.id, {
                onSuccess: () => {
                  onDisconnected();
                  onClose();
                },
              })
            }
          >
            Disconnect
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

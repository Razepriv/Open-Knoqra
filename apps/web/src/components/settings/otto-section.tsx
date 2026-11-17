import { Button, Reveal, StatusDot } from '@knoqra/ui';
import { type FormEvent, useEffect, useState } from 'react';
import { formatDate } from '../../lib/format';
import {
  type OttoConnection,
  ottoKeyErrorMessage,
  useDisconnectOtto,
  useOttoConnection,
  useSaveOttoKey,
  useStartChatGptSignIn,
} from '../../lib/otto';
import { SkeletonGroup, SkeletonLines } from '../calls/call-skeletons';
import { Field } from '../field';
import { FormAlert } from '../form-alert';
import { EarlyAccessTag } from '../otto/early-access-tag';
import { QueryStatePanel } from '../states/state-panel';
import { useToast } from '../use-toast';
import { SettingsSection } from './section';

export const OTTO_SECTION = {
  id: 'otto',
  title: 'Otto',
  description:
    'Otto drafts replies, writes briefs and sums up what you missed from your own records. Connect a model so Otto can answer.',
};

const KEYS_URL = 'https://platform.openai.com/api-keys';
const muted = 'text-[14px] text-[color:var(--muted)] leading-relaxed';

/** The headline for each mode, and whether it counts as connected. */
function statusOf(status: OttoConnection): { dot: 'ok' | 'warn' | 'none'; label: string } {
  switch (status.mode) {
    case 'own_key':
      return { dot: 'ok', label: 'Connected with your OpenAI key' };
    case 'chatgpt':
      return { dot: 'ok', label: 'Connected with your ChatGPT plan' };
    case 'included':
      return {
        dot: 'ok',
        label: status.plan ? `Included in your ${status.plan} plan` : 'Included in your plan',
      };
    case 'instance':
      return { dot: 'ok', label: "Connected through this server's model" };
    case 'demo':
      return { dot: 'warn', label: 'Demo mode: sample drafts, no model' };
    case 'upgrade':
      return { dot: 'none', label: 'Not included in your plan' };
    case 'connect':
      return { dot: 'none', label: 'Not connected' };
  }
}

/** One line per mode under the headline, saying what it means for the workspace. */
function explanation(status: OttoConnection): string | null {
  switch (status.mode) {
    case 'own_key':
    case 'chatgpt':
      return 'OpenAI bills your own account for what Otto uses.';
    case 'included':
      return status.earlyAccess
        ? 'Otto runs on a free model while in early access, so it can be busy at times. Your records go only to endpoints that neither train on nor keep them. You can connect your own OpenAI key instead.'
        : 'Otto uses KNOQRA’s model account. You can connect your own OpenAI key instead.';
    case 'demo':
      return 'Otto builds drafts from your records without a model. Connect an OpenAI key for real answers.';
    case 'upgrade':
      return 'Your plan does not include Otto. Connect your own OpenAI key, or upgrade.';
    case 'connect':
      return 'Paste an OpenAI API key so Otto can answer.';
    default:
      return null;
  }
}

/** The `?otto=` result OpenAI's sign-in sends the browser back with, read once. */
function useSignInResult(show: (message: string) => void) {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('otto');
    if (!result) return;
    if (result === 'connected') show('Otto is connected to your ChatGPT plan.');
    else if (result === 'cancelled') show('ChatGPT sign-in was cancelled.');
    else show('ChatGPT sign-in did not finish. Try again, or paste an OpenAI key.');
    url.searchParams.delete('otto');
    window.history.replaceState(window.history.state, '', url.toString());
  }, [show]);
}

/**
 * Settings › Otto: where Otto's answers come from, today's use against the fair-use limit, and,
 * for owners and admins, connecting the workspace's own OpenAI key (checked with OpenAI, stored
 * encrypted, never shown again) or, where offered, its ChatGPT plan.
 */
export function OttoSection() {
  const connection = useOttoConnection();
  const { show, toast } = useToast();
  useSignInResult(show);
  return (
    <SettingsSection {...OTTO_SECTION}>
      <Reveal loading={connection.isPending}>
        {connection.isPending ? (
          <SkeletonGroup label="Loading Otto's connection" className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-[18px] bg-[color:var(--cell)] px-4 py-3">
              <SkeletonLines widths={[46, 80, 60]} />
            </div>
          </SkeletonGroup>
        ) : connection.data ? (
          <OttoStatus status={connection.data} onDone={show} />
        ) : (
          <QueryStatePanel
            error={connection.error}
            onRetry={() => void connection.refetch()}
            retrying={connection.isFetching}
            subject="Otto's connection"
          />
        )}
      </Reveal>
      {toast}
    </SettingsSection>
  );
}

function OttoStatus({
  status,
  onDone,
}: {
  status: OttoConnection;
  onDone: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const disconnect = useDisconnectOtto();
  const chatgpt = useStartChatGptSignIn();
  const head = statusOf(status);
  const own = status.connection;
  const usesOwn = status.mode === 'own_key' || status.mode === 'chatgpt';
  const needsKey = status.mode === 'connect' || status.mode === 'upgrade' || status.mode === 'demo';
  const showForm = status.canManage && (editing || needsKey);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-[18px] bg-[color:var(--cell)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot status={head.dot} label={head.label} />
          {status.earlyAccess ? <EarlyAccessTag /> : null}
        </div>
        {usesOwn && own ? (
          <p className="font-[family-name:var(--font-mono)] text-[12px] text-[color:var(--muted)] leading-snug">
            {own.kind === 'api_key' && own.last4 ? `KEY ••••${own.last4} · ` : ''}
            {`MODEL ${own.model} · SAVED ${formatDate(own.updatedAt).toUpperCase()}`}
          </p>
        ) : null}
        {explanation(status) ? <p className={muted}>{explanation(status)}</p> : null}
        {status.dailyLimit ? (
          <p className="text-[13px] text-[color:var(--muted)] leading-snug">
            {`${status.usedToday} of ${status.dailyLimit} requests used today. The count resets at midnight UTC.`}
          </p>
        ) : null}
      </div>

      {status.mode === 'upgrade' && status.upgradePath ? (
        <a
          href={status.upgradePath}
          className="self-start text-[14px] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2"
        >
          See plans that include Otto
        </a>
      ) : null}

      {showForm ? (
        <KeyForm
          replacing={usesOwn}
          onDone={(message) => {
            setEditing(false);
            if (message) onDone(message);
          }}
          cancellable={editing}
        />
      ) : null}

      {status.canManage ? (
        <div className="flex flex-wrap gap-2">
          {showForm ? null : (
            <Button variant="ghost" className="h-11 px-6" onClick={() => setEditing(true)}>
              {status.mode === 'own_key' ? 'Replace key' : 'Use your own OpenAI key'}
            </Button>
          )}
          {status.chatgptSignIn && status.mode !== 'chatgpt' ? (
            <Button
              variant="ghost"
              className="h-11 px-6"
              disabled={chatgpt.isPending}
              aria-busy={chatgpt.isPending}
              onClick={() => chatgpt.mutate()}
            >
              Continue with ChatGPT
            </Button>
          ) : null}
          {own ? (
            <Button
              variant="ghost"
              className="h-11 px-6"
              disabled={disconnect.isPending}
              aria-busy={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(undefined, { onSuccess: () => onDone('Otto disconnected.') })
              }
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : (
        <p className={muted}>Only owners and admins can connect Otto.</p>
      )}
      <FormAlert
        message={
          chatgpt.isError
            ? 'We could not start the ChatGPT sign-in. Try again.'
            : disconnect.isError
              ? 'We could not disconnect Otto. Try again.'
              : null
        }
      />
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">
        Otto sends OpenAI only the records you ask it about, with OpenAI’s response storage turned
        off. Its drafts are saved in your workspace; what it reads and writes never goes into
        KNOQRA’s logs.
      </p>
    </div>
  );
}

function KeyForm({
  replacing,
  cancellable,
  onDone,
}: {
  replacing: boolean;
  cancellable: boolean;
  onDone: (message: string | null) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useSaveOttoKey();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = apiKey.trim();
    if (key.length < 20 || /\s/.test(key)) {
      setError('Paste the whole key. It starts with sk- and has no spaces.');
      return;
    }
    setError(null);
    save.mutate(key, {
      onSettled: () => {
        // The key never stays in the page, or in the mutation cache, once the server has it.
        setApiKey('');
        save.reset();
      },
      onError: (failure) => setError(ottoKeyErrorMessage(failure)),
      onSuccess: () => onDone('Otto is connected to your OpenAI key.'),
    });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Field
        id="otto-api-key"
        label="OpenAI API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        placeholder={replacing ? 'Paste a new key to replace the saved one' : 'sk-...'}
        onChange={(event) => setApiKey(event.target.value)}
        hint="We check it with OpenAI, store it encrypted and never show it again."
      />
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">
        Create a key at{' '}
        <a
          href={KEYS_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          platform.openai.com/api-keys
        </a>
        . A project key with a spending limit is a good idea.
      </p>
      <FormAlert message={error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={save.isPending}
          aria-busy={save.isPending}
          className="h-11 px-6"
        >
          {save.isPending ? 'Checking the key…' : 'Save key'}
        </Button>
        {cancellable ? (
          <Button variant="ghost" className="h-11 px-6" onClick={() => onDone(null)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

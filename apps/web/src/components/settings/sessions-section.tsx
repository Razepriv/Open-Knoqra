import { Button, Reveal } from '@knoqra/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../lib/api';
import { authClient } from '../../lib/auth';
import { relativeTime } from '../../lib/format';
import { loadFailed } from '../../lib/query-state';
import {
  currentSessionToken,
  revokeLabel,
  type SessionRow,
  sessionsKey,
  toSessionRows,
} from '../../lib/sessions';
import { FormAlert } from '../form-alert';
import { SessionsBodySkeleton } from '../skeletons/settings-skeleton';
import { QueryStatePanel } from '../states/state-panel';
import { useToast } from '../use-toast';
import { SettingsSection } from './section';

async function loadSessions(): Promise<SessionRow[]> {
  const [list, current] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
  if (list.error || !list.data) {
    throw new ApiError(list.error?.status ?? 0, 'Could not load your devices.');
  }
  // Without knowing which session is this one, any row could be the user's own: show the error
  // state instead of rows that offer Revoke on every device.
  const currentToken = currentSessionToken(current);
  if (!currentToken)
    throw new ApiError(current.error?.status ?? 0, 'Could not identify this device.');
  return toSessionRows(list.data, currentToken);
}

async function revoke(token: string): Promise<void> {
  const { error } = await authClient.revokeSession({ token });
  if (error) throw new ApiError(error.status ?? 0, 'Could not sign that device out.');
}

async function revokeOthers(): Promise<void> {
  const { error } = await authClient.revokeOtherSessions();
  if (error) throw new ApiError(error.status ?? 0, 'Could not sign the other devices out.');
}

/** Where the account is signed in, with a way to end any session that is not this one. */
export function SessionsSection() {
  const queryClient = useQueryClient();
  const { show, toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: loadSessions,
    staleTime: 0,
    gcTime: 0,
  });

  const onSuccess = async (message: string) => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: sessionsKey });
    show(message);
  };
  const onError = () => setError('We could not sign that out. Try again in a moment.');

  const revokeOne = useMutation({
    mutationFn: revoke,
    onSuccess: () => onSuccess('Device signed out'),
    onError,
  });
  const revokeAll = useMutation({
    mutationFn: revokeOthers,
    onSuccess: () => onSuccess('Other devices signed out'),
    onError,
  });

  const rows = sessions.data ?? [];
  const others = rows.filter((row) => !row.current).length;
  const busy = revokeOne.isPending || revokeAll.isPending;

  return (
    <SettingsSection
      id="sessions"
      title="Sessions"
      description="Browsers and devices signed in to your account. Sign out any you do not recognise."
    >
      <Reveal loading={sessions.isPending}>
        {sessions.isPending ? (
          <SessionsBodySkeleton label="Loading your devices" />
        ) : loadFailed(sessions) ? (
          <QueryStatePanel
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
            retrying={sessions.isFetching}
            subject="your devices"
            headingLevel={3}
          />
        ) : (
          <ul aria-label="Signed-in devices" className="flex flex-col gap-2">
            {rows.map((row) => (
              <SessionItem
                key={row.id}
                row={row}
                busy={busy}
                onRevoke={() => revokeOne.mutate(row.token)}
              />
            ))}
          </ul>
        )}
      </Reveal>
      <FormAlert message={error} />
      {others > 0 ? (
        <Button
          variant="ghost"
          className="self-start"
          disabled={busy}
          aria-busy={revokeAll.isPending}
          onClick={() => revokeAll.mutate()}
        >
          Sign out other devices
        </Button>
      ) : null}
      {toast}
    </SettingsSection>
  );
}

interface SessionItemProps {
  row: SessionRow;
  busy: boolean;
  onRevoke: () => void;
}

function SessionItem({ row, busy, onRevoke }: SessionItemProps) {
  const Icon = /iOS|Android/.test(row.device) ? Smartphone : Monitor;
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 py-3 [box-shadow:var(--cellShadow)]">
      <Icon size={20} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 font-medium text-[14px] leading-none">
          {row.device}
          {row.current ? (
            <span className="rounded-full bg-[color:var(--accent)] px-2 py-[3px] font-semibold text-[color:var(--on-accent)] text-[11px] leading-none">
              This device
            </span>
          ) : null}
        </p>
        <p className="font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-snug">
          {row.ip ? `${row.ip} · ` : ''}
          {relativeTime(row.lastActive)}
        </p>
      </div>
      {row.current ? null : (
        <Button
          variant="ghost"
          className="h-9 shrink-0 px-3"
          disabled={busy}
          aria-label={revokeLabel(row)}
          onClick={onRevoke}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

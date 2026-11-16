import { Avatar, Button, Reveal } from '@knoqra/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Phone, Voicemail as VoicemailIcon } from 'lucide-react';
import { callErrorMessage, formatDuration, useMarkListened, type Voicemail } from '../../lib/calls';
import { formatPhone, gradientFor } from '../../lib/contacts';
import { relativeTime } from '../../lib/format';
import { useNow } from '../../lib/use-now';
import { VoicemailSkeleton } from './call-skeletons';

const NOW_TICK_MS = 60_000;

export const rowSurface =
  'rounded-[18px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]';
export const monoLine =
  'font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none';

/** Fills the dialer with this caller: the contact when there is one, otherwise the number. */
export function useCallBack(): (target: { contactId?: string | null; number: string }) => void {
  const navigate = useNavigate();
  return ({ contactId, number }) =>
    void navigate({ to: '/calls', search: contactId ? { contactId } : { to: number } });
}

export interface VoicemailListProps {
  /** The voicemails query, shared with the tab badge so both read one cache entry. */
  query: UseQueryResult<Voicemail[]>;
}

/** Voicemails, newest first, with the transcript, Call back, and Mark listened while unread. */
export function VoicemailList({ query }: VoicemailListProps) {
  const now = useNow(NOW_TICK_MS);
  const items = query.data ?? [];
  return (
    <Reveal loading={query.isPending}>
      {query.isPending ? (
        <VoicemailSkeleton />
      ) : query.isError && items.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-[14px] text-[color:var(--muted)]">We could not load your voicemail.</p>
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
          No voicemail. When a caller leaves a message, it shows here with a transcript.
        </p>
      ) : (
        <ul aria-label="Voicemail" className="flex min-h-0 flex-col gap-2 overflow-auto p-[2px]">
          {items.map((item) => (
            <VoicemailRow key={item.id} voicemail={item} now={now} />
          ))}
        </ul>
      )}
    </Reveal>
  );
}

function VoicemailRow({ voicemail, now }: { voicemail: Voicemail; now: Date }) {
  const markListened = useMarkListened();
  const callBack = useCallBack();
  const unread = voicemail.listenedAt === null;
  const name = voicemail.contact?.displayName ?? formatPhone(voicemail.fromE164);
  return (
    <li className={`flex flex-col gap-3 p-4 ${rowSurface}`}>
      <div className="flex items-center gap-[10px]">
        <Avatar
          name={name}
          gradient={gradientFor(voicemail.contact?.id ?? voicemail.fromE164)}
          size={36}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-[7px] font-semibold text-[14px] leading-[1.1]">
            {unread ? (
              <span
                role="img"
                aria-label="Unread"
                className="size-[8px] shrink-0 rounded-full bg-[color:var(--accent)] [box-shadow:0_0_0_2px_var(--pill)]"
              />
            ) : null}
            <span className="truncate">{`${name} · ${formatDuration(voicemail.durationSeconds)}`}</span>
          </span>
          <span className={`truncate uppercase ${monoLine}`}>
            {`${formatPhone(voicemail.fromE164)} · ${relativeTime(voicemail.createdAt, now)}`}
          </span>
        </div>
      </div>
      <p className="flex items-center gap-2 text-[12.5px] text-[color:var(--muted)] leading-snug">
        <VoicemailIcon size={14} strokeWidth={1.75} aria-hidden="true" />
        Audio playback arrives with live Telnyx.
      </p>
      <div className="flex flex-col gap-[6px] rounded-[14px] bg-[color:var(--cell)] p-3">
        <span className="font-[family-name:var(--font-mono)] font-medium text-[10.5px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]">
          Transcript may be inaccurate
        </span>
        <span className="text-[13.5px] leading-normal">
          {voicemail.transcript ? `“${voicemail.transcript}”` : 'No transcript for this message.'}
        </span>
      </div>
      {markListened.isError ? (
        <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
          {callErrorMessage(markListened.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => callBack({ contactId: voicemail.contact?.id, number: voicemail.fromE164 })}
        >
          <Phone size={15} strokeWidth={1.75} aria-hidden="true" />
          Call back
        </Button>
        {unread ? (
          <Button
            variant="ghost"
            onClick={() => markListened.mutate(voicemail.id)}
            disabled={markListened.isPending}
            aria-busy={markListened.isPending}
          >
            Mark listened
          </Button>
        ) : null}
      </div>
    </li>
  );
}

import { Avatar, Button, Panel, Reveal } from '@knoqra/ui';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { deskSlot } from '../../extensions';
import { useMe } from '../../lib/api';
import {
  type Call,
  canLogOutcome,
  outcomeLabel,
  recentStateCopy,
  unreadCount,
  useCalls,
  useVoicemails,
} from '../../lib/calls';
import { formatPhone, gradientFor } from '../../lib/contacts';
import { callStateDot } from '../../lib/dial';
import { relativeTime } from '../../lib/format';
import { focusRing, textPill } from '../../lib/ui-classes';
import { useLoadMoreOnScroll } from '../../lib/use-load-more';
import { useNow } from '../../lib/use-now';
import { useCallSession } from './call-session';
import { RecentsSkeleton } from './call-skeletons';
import { callName, remoteNumber } from './live-call-panel';
import { monoLine, rowSurface, useCallBack, VoicemailList } from './voicemail-list';

type Tab = 'recents' | 'voicemail';
const TABS: readonly Tab[] = ['recents', 'voicemail'];
const NOW_TICK_MS = 60_000;

/**
 * The Calls panel beside the dialer when no call is shown: Recents (every call, newest first, with
 * infinite load) and Voicemail, whose tab counts the voicemails nobody has listened to.
 */
export function CallsPanel() {
  const [tab, setTab] = useState<Tab>('recents');
  const voicemails = useVoicemails();
  const unread = unreadCount(voicemails.data);
  const baseId = useId();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ recents: null, voicemail: null });

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length] ?? 'recents';
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabButton = (value: Tab, label: string, badge: number) => (
    <button
      ref={(node) => {
        tabRefs.current[value] = node;
      }}
      type="button"
      role="tab"
      id={`${baseId}-${value}-tab`}
      aria-controls={`${baseId}-${value}-panel`}
      aria-selected={tab === value}
      aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
      tabIndex={tab === value ? 0 : -1}
      onClick={() => setTab(value)}
      className={`inline-flex h-9 cursor-pointer items-center gap-[6px] rounded-[18px] border border-[color:var(--pillBorder)] px-[13px] font-medium text-[13px] text-[color:var(--text)] leading-none ${
        tab === value
          ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
          : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]'
      } ${focusRing}`}
    >
      {label}
      {badge > 0 ? (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[color:var(--accent)] px-[5px] font-[family-name:var(--font-mono)] font-semibold text-[10.5px] text-[color:var(--on-accent)] leading-none">
          {badge}
        </span>
      ) : null}
    </button>
  );

  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <section aria-label="Calls" className="flex min-h-0 flex-1 flex-col gap-3 p-[18px]">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-[family-name:var(--font-display)] text-[30px] leading-none tracking-[-0.025em]">
            Calls
          </h2>
          <span className="flex-1" />
          <div role="tablist" aria-label="Calls" className="flex gap-2" onKeyDown={onKey}>
            {tabButton('recents', 'Recents', 0)}
            {tabButton('voicemail', 'Voicemail', unread)}
          </div>
        </div>
        <div
          role="tabpanel"
          id={`${baseId}-${tab}-panel`}
          aria-labelledby={`${baseId}-${tab}-tab`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {tab === 'recents' ? <RecentsList /> : <VoicemailList query={voicemails} />}
        </div>
      </section>
    </Panel>
  );
}

/** Every call, newest first; the next page loads as the end scrolls into view. */
export function RecentsList() {
  const calls = useCalls('all');
  const meId = useMe().data?.user.id;
  const now = useNow(NOW_TICK_MS);
  const items = calls.data?.pages.flatMap((page) => page.items) ?? [];
  const sentinel = useLoadMoreOnScroll({
    enabled: Boolean(calls.hasNextPage) && !calls.isFetchNextPageError,
    busy: calls.isFetchingNextPage,
    loadMore: () => void calls.fetchNextPage(),
    pageCount: calls.data?.pages.length ?? 0,
  });

  return (
    <Reveal loading={calls.isPending}>
      {calls.isPending ? (
        <RecentsSkeleton />
      ) : calls.isError && items.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p className="text-[14px] text-[color:var(--muted)]">
            We could not load your recent calls.
          </p>
          <Button variant="ghost" onClick={() => void calls.refetch()}>
            Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-[14px] text-[color:var(--muted)] leading-relaxed">
          No calls yet. Dial a number or pick a contact to place your first call.
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-[2px]">
          <ul aria-label="Recent calls" className="flex flex-col gap-2">
            {items.map((call) => (
              <RecentRow key={call.id} call={call} now={now} meId={meId} />
            ))}
            <li ref={sentinel} aria-hidden="true" className="h-px" />
          </ul>
          {calls.isFetchNextPageError ? (
            <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
              We could not load more calls. Try again.
            </p>
          ) : null}
          {calls.hasNextPage ? (
            <Button
              variant="ghost"
              className="self-center"
              onClick={calls.isFetchingNextPage ? undefined : () => void calls.fetchNextPage()}
              aria-disabled={calls.isFetchingNextPage}
              aria-busy={calls.isFetchingNextPage}
            >
              Load more
            </Button>
          ) : null}
        </div>
      )}
    </Reveal>
  );
}

function RecentRow({ call, now, meId }: { call: Call; now: Date; meId: string | undefined }) {
  const session = useCallSession();
  const callBack = useCallBack();
  const name = callName(call);
  const number = remoteNumber(call);
  const inbound = call.direction === 'inbound';
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  const CallRowActions = deskSlot('CallRowActions');
  return (
    <li
      className={`grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-[10px] ${rowSurface}`}
    >
      <Avatar name={name} gradient={gradientFor(call.contact?.id ?? number)} size={36} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-[6px] font-semibold text-[14px] leading-[1.1]">
          <Icon
            size={13}
            strokeWidth={1.75}
            role="img"
            aria-label={inbound ? 'Inbound' : 'Outbound'}
            className="shrink-0"
          />
          <span className="truncate">{name}</span>
        </span>
        <span className={`truncate ${monoLine}`}>
          {`${formatPhone(number)} · ${relativeTime(call.createdAt, now)}`}
        </span>
        <span className="flex flex-wrap items-center gap-[6px] pt-[2px]">
          <span className="flex h-[24px] items-center gap-[6px] whitespace-nowrap rounded-[12px] bg-[color:var(--cell)] px-[9px] font-medium text-[11px] leading-none">
            <span
              aria-hidden="true"
              className="size-[6px] rounded-full"
              style={{ background: `var(--dot-${callStateDot(call.state)})` }}
            />
            {recentStateCopy(call)}
          </span>
          {call.outcome ? (
            <span className="flex h-[24px] items-center whitespace-nowrap rounded-[12px] border border-[color:var(--pillBorder)] px-[9px] font-[family-name:var(--font-mono)] text-[10.5px] uppercase leading-none tracking-[.04em]">
              {outcomeLabel(call.outcome)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {canLogOutcome(call, meId) ? (
          <button type="button" className={textPill} onClick={() => session.openOutcome(call.id)}>
            Log outcome
          </button>
        ) : null}
        {CallRowActions ? <CallRowActions call={call} /> : null}
        <button
          type="button"
          aria-label={`Call back ${name}`}
          title="Put this number in the dialer"
          onClick={() => callBack({ contactId: call.contact?.id, number })}
          className={`flex size-[38px] cursor-pointer items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--cell)] text-[color:var(--text)] ${focusRing}`}
        >
          <PhoneOutgoing size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

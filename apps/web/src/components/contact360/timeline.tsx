import { Button, Panel, Pill, Reveal } from '@knoqra/ui';
import {
  Info,
  type LucideIcon,
  MessageSquare,
  NotebookPen,
  Phone,
  ShieldCheck,
  SquareCheck,
} from 'lucide-react';
import { useMemo } from 'react';
import { deskSlot } from '../../extensions';
import { groupByDay, type TimelineEvent } from '../../lib/contact360';
import { type TimelineFilter, useTimeline } from '../../lib/contact360-queries';
import { formatTime } from '../../lib/format';
import { useLoadMoreOnScroll } from '../../lib/use-load-more';
import { useNow } from '../../lib/use-now';
import { TimelineEntriesSkeleton } from '../skeletons/contact360-skeleton';
import { QueryStatePanel, StatePanel } from '../states/state-panel';
import { NoteComposer } from './note-composer';

const FILTERS: readonly { value: TimelineFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'calls', label: 'Calls' },
  { value: 'messages', label: 'Messages' },
  { value: 'notes_consent', label: 'Notes & consent' },
];

/** The empty timeline, per filter: a title and one sentence on what will appear. */
const EMPTY_COPY: Record<TimelineFilter, { title: string; body: string }> = {
  all: {
    title: 'Nothing here yet',
    body: 'Notes, consent changes, calls and messages will appear on this timeline.',
  },
  calls: {
    title: 'No calls with this contact yet.',
    body: 'Calls you place or log with them appear here.',
  },
  messages: {
    title: 'No messages yet.',
    body: 'SMS and WhatsApp conversations with them appear here.',
  },
  notes_consent: {
    title: 'No notes or consent changes yet.',
    body: 'Notes you add and every consent change appear here.',
  },
};

const KIND_ICON: Record<TimelineEvent['kind'], LucideIcon> = {
  call: Phone,
  message: MessageSquare,
  note: NotebookPen,
  consent: ShieldCheck,
  system: Info,
  task: SquareCheck,
};

const KIND_GRADIENT: Record<TimelineEvent['kind'], string> = {
  call: 'var(--grad-peri)',
  message: 'var(--grad-mint)',
  note: 'var(--grad-amber)',
  consent: 'var(--grad-cit)',
  system: 'var(--grad-grey)',
  task: 'var(--grad-apr)',
};

const mono =
  'font-[family-name:var(--font-mono)] text-[10.5px] uppercase tracking-[.04em] text-[color:var(--muted)]';

export interface TimelineProps {
  contactId: string;
  filter: TimelineFilter;
  onFilterChange: (filter: TimelineFilter) => void;
  /** Archived and merged contacts cannot take new notes. */
  readOnly: boolean;
}

export function Timeline({ contactId, filter, onFilterChange, readOnly }: TimelineProps) {
  const query = useTimeline(contactId, filter);
  const now = useNow(60_000);
  const events = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const groups = useMemo(() => groupByDay(events, now), [events, now]);
  const sentinel = useLoadMoreOnScroll({
    enabled: query.hasNextPage && !query.isFetchNextPageError,
    busy: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    pageCount: events.length,
  });

  return (
    <Panel
      role="region"
      aria-label="Timeline"
      className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-[18px]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-[family-name:var(--font-display)] font-medium text-[18px] leading-none">
          Timeline
        </h2>
        <span className={`${mono} ml-1 hidden sm:inline`}>Every channel, one record</span>
        <span className="flex-1" />
        <div className="flex flex-wrap gap-[6px]">
          {FILTERS.map(({ value, label }) => (
            <Pill
              key={value}
              size="sm"
              pressed={filter === value}
              onClick={() => onFilterChange(value)}
            >
              {label}
            </Pill>
          ))}
        </div>
      </div>

      {readOnly ? null : <NoteComposer contactId={contactId} />}

      <Reveal loading={query.isPending}>
        {query.isPending ? (
          <TimelineEntriesSkeleton label="Loading timeline" />
        ) : query.isError && events.length === 0 ? (
          <QueryStatePanel
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            subject="the timeline"
            headingLevel={3}
          />
        ) : events.length === 0 ? (
          <StatePanel
            kind="empty"
            title={EMPTY_COPY[filter].title}
            body={EMPTY_COPY[filter].body}
            headingLevel={3}
          />
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <section
                key={`${group.label}-${group.events[0]?.id}`}
                className="flex flex-col gap-2"
              >
                <h3 className={mono}>{group.label}</h3>
                <ol className="flex flex-col gap-2">
                  {group.events.map((event) => (
                    <TimelineEntry key={event.id} event={event} />
                  ))}
                </ol>
              </section>
            ))}
            <ul aria-hidden="true">
              <li ref={sentinel} className="h-px" />
            </ul>
          </div>
        )}
      </Reveal>

      {query.isFetchNextPageError ? (
        <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
          We could not load more of the timeline. Try again.
        </p>
      ) : null}
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={query.isFetchingNextPage ? undefined : () => void query.fetchNextPage()}
            aria-disabled={query.isFetchingNextPage}
            aria-busy={query.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}

function TimelineEntry({ event }: { event: TimelineEvent }) {
  const Icon = KIND_ICON[event.kind];
  const time = formatTime(event.occurredAt);
  return (
    <li className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-3 sm:grid-cols-[40px_minmax(0,1fr)_72px]">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-[13px] text-[color:var(--on-accent)] [box-shadow:var(--shadow-tile)]"
        style={{ background: KIND_GRADIENT[event.kind] }}
      >
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <EntryBody event={event} />
      <time
        dateTime={event.occurredAt}
        className="col-start-2 text-[11px] text-[color:var(--muted)] sm:col-start-3 sm:pt-3 sm:text-right"
      >
        <span className="font-[family-name:var(--font-mono)] font-medium">{time}</span>
      </time>
    </li>
  );
}

/** The mono word above each entry: what kind of record it is, and on which channel. */
function eyebrow(event: TimelineEvent): string {
  if (event.kind === 'message') {
    const hint = `${event.refType ?? ''} ${event.source}`.toLowerCase();
    if (hint.includes('whatsapp')) return 'WhatsApp';
    if (hint.includes('sms')) return 'SMS';
    return 'Message';
  }
  return EYEBROW[event.kind];
}

const EYEBROW: Record<TimelineEvent['kind'], string> = {
  call: 'Call',
  message: 'Message',
  note: 'Note',
  consent: 'Consent',
  system: 'System',
  task: 'Task',
};

/** Where the record came from, as the mono meta line says it ("desk", "csv import"). */
const sourceLabel = (source: string): string => source.replaceAll('_', ' ');

const ROW = 'flex flex-col gap-1 rounded-[16px] px-[14px] py-[10px]';
const ROW_LOOK: Record<TimelineEvent['kind'], string> = {
  call: 'bg-[color:var(--cell)]',
  message: 'bg-[color:var(--cell)]',
  consent: 'bg-[color:var(--cell)]',
  task: 'bg-[color:var(--cell)]',
  // An internal note keeps its hatch, and a system line its dashed policy outline.
  note: 'border border-[color:var(--panelBorder)] [background:var(--hatch)]',
  system: 'border border-[color:var(--muted)] border-dashed',
};

/**
 * One record as a filled cell: the mono channel word and the bold title, the body, then a mono
 * meta line with where it came from (an internal note also says it was never sent).
 */
function EntryBody({ event }: { event: TimelineEvent }) {
  const Extra = deskSlot('TimelineEntryExtra');
  const meta = [
    event.kind === 'note' ? 'Internal only · not sent' : null,
    event.source ? sourceLabel(event.source) : null,
  ].filter(Boolean);
  return (
    <div className={`${ROW} ${ROW_LOOK[event.kind]}`}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={mono}>{eyebrow(event)}</span>
        <span className="font-semibold text-[13.5px] leading-[1.25]">{event.title}</span>
      </p>
      {/* A note or a consent reason is what someone typed: keep its line breaks. */}
      {event.body ? (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.45]">{event.body}</p>
      ) : null}
      {meta.length > 0 ? <p className={`${mono} leading-[1.5]`}>{meta.join(' · ')}</p> : null}
      {Extra ? <Extra event={event} /> : null}
    </div>
  );
}

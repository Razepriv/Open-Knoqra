import { Button, Panel, Reveal } from '@knoqra/ui';
import { FileText, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { type Conversation, type InboxFilter, useConversations, useSenders } from '../../lib/inbox';
import { focusRing, iconPill } from '../../lib/ui-classes';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useLoadMoreOnScroll } from '../../lib/use-load-more';
import { useNow } from '../../lib/use-now';
import { ChannelsBar } from './channels-bar';
import { InboxLoadError, NoSenders, NoThreads } from './inbox-empty';
import { ThreadRowsSkeleton } from './inbox-skeletons';
import { NewThreadDialog } from './new-thread-dialog';
import { ThreadRow } from './thread-row';

export interface ThreadListProps {
  filter: InboxFilter;
  selectedId?: string | undefined;
  onFilterChange: (filter: InboxFilter) => void;
  onSelect: (id: string) => void;
  /** Opens the templates dialog; focus returns to the element given when it closes. */
  onOpenTemplates: (returnFocus: () => HTMLElement | null) => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const NOW_REFRESH_MS = 30_000;

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' },
];

export function ThreadList({
  filter,
  selectedId,
  onFilterChange,
  onSelect,
  onOpenTemplates,
}: ThreadListProps) {
  const [draft, setDraft] = useState('');
  const q = useDebouncedValue(draft.trim(), SEARCH_DEBOUNCE_MS);
  const [creating, setCreating] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const templatesButton = useRef<HTMLButtonElement>(null);
  const now = useNow(NOW_REFRESH_MS);
  const senders = useSenders();
  const conversations = useConversations(filter, q);
  const items: Conversation[] = useMemo(
    () => conversations.data?.pages.flatMap((page) => page.items) ?? [],
    [conversations.data],
  );
  const sentinel = useLoadMoreOnScroll({
    enabled: conversations.hasNextPage && !conversations.isFetchNextPageError,
    busy: conversations.isFetchingNextPage,
    loadMore: () => void conversations.fetchNextPage(),
    pageCount: items.length,
  });

  const noSenders = senders.data !== undefined && senders.data.items.length === 0;
  const pending = conversations.isPending || senders.isPending;

  return (
    <Panel
      aria-label="Threads"
      className="flex min-h-0 flex-col gap-3 overflow-hidden px-3 pt-[18px] pb-3"
    >
      <div className="flex items-center gap-2 px-2">
        <h1 className="font-[family-name:var(--font-display)] text-[30px] leading-none tracking-[-0.025em]">
          Inbox
        </h1>
        <span className="flex-1" />
        <button
          ref={templatesButton}
          type="button"
          aria-label="Templates"
          title="Templates"
          className={`${iconPill} size-9`}
          onClick={() => onOpenTemplates(() => templatesButton.current)}
        >
          <FileText size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <Button
          ref={newButton}
          variant="primary"
          className="h-9 px-3"
          disabled={noSenders}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
          New message
        </Button>
      </div>
      <ChannelsBar />

      <fieldset
        aria-label="Filter conversations"
        className="flex flex-wrap gap-[6px] border-0 p-0 px-[6px]"
      >
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilterChange(value)}
            className={`h-[34px] cursor-pointer rounded-full border border-[color:var(--pillBorder)] px-3 font-medium text-[13px] leading-none ${focusRing} ${
              filter === value
                ? 'bg-[color:var(--accent)] text-[color:var(--on-accent)]'
                : 'bg-[color:var(--pill)] text-[color:var(--text)] [box-shadow:var(--pillShadow)]'
            }`}
          >
            {label}
          </button>
        ))}
      </fieldset>

      <label className="mx-1 flex h-11 items-center gap-2 rounded-full bg-[color:var(--cell)] px-4 text-[color:var(--muted)] [box-shadow:var(--cellShadow)] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search conversations"
          placeholder="Search name, company or number"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--text)] outline-none placeholder:text-[color:var(--muted)]"
        />
      </label>

      <Reveal loading={pending} className="min-h-0 flex-1 overflow-auto">
        {pending ? (
          <ThreadRowsSkeleton />
        ) : noSenders && senders.data ? (
          <NoSenders sandboxAvailable={senders.data.sandboxAvailable} />
        ) : conversations.isError && items.length === 0 ? (
          <InboxLoadError
            onRetry={() => void conversations.refetch()}
            retrying={conversations.isFetching}
          />
        ) : items.length === 0 ? (
          <NoThreads q={q} filtered={filter !== 'all'} />
        ) : (
          <ul aria-label="Conversations" className="flex flex-col gap-2 p-1">
            {items.map((conversation) => (
              <ThreadRow
                key={conversation.id}
                conversation={conversation}
                selected={conversation.id === selectedId}
                now={now}
                onSelect={onSelect}
              />
            ))}
            <li ref={sentinel} aria-hidden="true" className="h-px" />
          </ul>
        )}
      </Reveal>

      {conversations.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={
              conversations.isFetchingNextPage
                ? undefined
                : () => void conversations.fetchNextPage()
            }
            aria-busy={conversations.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
      {conversations.isError && items.length > 0 ? (
        <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
          We could not load more conversations. Try again.
        </p>
      ) : null}

      <NewThreadDialog
        open={creating}
        onOpenChange={setCreating}
        onOpened={onSelect}
        returnFocus={() => newButton.current}
      />
    </Panel>
  );
}

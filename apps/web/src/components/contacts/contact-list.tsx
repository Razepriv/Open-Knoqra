import { Button, Panel, Reveal } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { FileUp, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Contact,
  resultAnnouncement,
  searchPlaceholder,
  useContacts,
} from '../../lib/contacts';
import { contactListPanel, contactRowsList, contactSearchBox } from '../../lib/contacts-layout';
import { CONTACTS_IMPORT_PATH } from '../../lib/nav-items';
import { iconPill, textPill } from '../../lib/ui-classes';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useLoadMoreOnScroll } from '../../lib/use-load-more';
import { ContactRowsSkeleton } from '../skeletons/contacts-skeleton';
import { QueryStatePanel, StatePanel } from '../states/state-panel';
import { ContactRow } from './contact-row';
import { CreateContactDialog } from './create-contact-dialog';

export interface ContactListProps {
  /** The narrow list beside Contact 360. */
  compact?: boolean;
  /** The contact currently open, highlighted in the list. */
  activeId?: string;
  initialQuery?: string;
  /**
   * Changes on every completed navigation. The box re-reads `initialQuery` when it changes, even
   * if `initialQuery` itself did not: a link can supersede our own ?q= update before it lands
   * (the session check delays each navigation), leaving the address at '' both before and after.
   */
  navigationKey?: string;
  /** Called with the debounced search text, so a page can keep it in the URL. */
  onQueryChange?: (q: string) => void;
}

const SEARCH_DEBOUNCE_MS = 250;

function useSearch(
  initialQuery: string,
  navigationKey: string | undefined,
  onQueryChange?: (q: string) => void,
) {
  const [draft, setDraft] = useState(initialQuery);
  const q = useDebouncedValue(draft.trim(), SEARCH_DEBOUNCE_MS);
  // The text last synced with the address, in either direction.
  const last = useRef(initialQuery);
  // Follow the address: a link or back/forward can change ?q= without this box being typed in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigationKey re-runs the sync on purpose.
  useEffect(() => {
    if (initialQuery === last.current) return;
    last.current = initialQuery;
    setDraft(initialQuery);
  }, [initialQuery, navigationKey]);
  useEffect(() => {
    if (q === last.current) return;
    last.current = q;
    onQueryChange?.(q);
  }, [q, onQueryChange]);
  return { draft, setDraft, q };
}

export function ContactList({
  compact = false,
  activeId,
  initialQuery = '',
  navigationKey,
  onQueryChange,
}: ContactListProps) {
  const { draft, setDraft, q } = useSearch(initialQuery, navigationKey, onQueryChange);
  // Contact 360 owns the page's h1, so its narrow list is a level lower.
  const Heading = compact ? 'h2' : 'h1';
  const [creating, setCreating] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const openCreate = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreating(true);
  };
  // The empty state's button disappears once a contact exists, so fall back to the header button,
  // then the search box, rather than letting focus drop to the page body.
  const returnFocus = () =>
    opener.current?.isConnected ? opener.current : (addButton.current ?? searchBox.current);
  const contacts = useContacts({ q });
  const items: Contact[] = useMemo(
    () => contacts.data?.pages.flatMap((page) => page.items) ?? [],
    [contacts.data],
  );
  const sentinel = useLoadMoreOnScroll({
    enabled: contacts.hasNextPage && !contacts.isFetchNextPageError,
    busy: contacts.isFetchingNextPage,
    loadMore: () => void contacts.fetchNextPage(),
    pageCount: items.length,
  });

  // The count is exact only once every contact is loaded and nothing is filtered.
  const everyone = !contacts.isPending && !contacts.hasNextPage && q === '' && draft === '';
  const resultStatus = resultAnnouncement({
    settled: !contacts.isPending && !contacts.isError,
    count: items.length,
    more: contacts.hasNextPage === true,
    searching: q !== '',
  });

  return (
    <Panel role="region" aria-label="People" className={contactListPanel(compact)}>
      <div className="flex flex-wrap items-center gap-3">
        <Heading
          className={`font-[family-name:var(--font-display)] leading-none tracking-[-0.025em] ${
            compact ? 'px-2 text-[26px]' : 'text-[30px]'
          }`}
        >
          Contacts
        </Heading>
        <span className="flex-1" />
        {compact ? (
          <button
            ref={addButton}
            type="button"
            aria-label="Add contact"
            title="Add contact"
            onClick={openCreate}
            className={`${iconPill} size-10`}
          >
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : (
          <>
            <Link to={CONTACTS_IMPORT_PATH} className={textPill}>
              <FileUp size={15} strokeWidth={1.75} aria-hidden="true" />
              Import CSV
            </Link>
            <Button ref={addButton} variant="primary" onClick={openCreate}>
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              Add contact
            </Button>
          </>
        )}
      </div>

      <label
        className={`${contactSearchBox(compact)} text-[color:var(--muted)] focus-within:outline-2 focus-within:outline-[color:var(--line)] focus-within:outline-offset-2`}
      >
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={searchBox}
          type="search"
          aria-label="Search contacts"
          placeholder={
            compact
              ? searchPlaceholder(everyone ? items.length : null)
              : 'Search by name, company, email or number'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[14px] text-[color:var(--text)] outline-none placeholder:text-[color:var(--muted)]"
        />
      </label>

      {/* Always mounted: a live region only announces text that changes after it exists. */}
      <p role="status" className="sr-only">
        {resultStatus}
      </p>

      <Reveal
        loading={contacts.isPending}
        className={compact ? 'min-h-0 flex-1 overflow-auto' : ''}
      >
        {contacts.isPending ? (
          <ContactRowsSkeleton compact={compact} label="Loading contacts" />
        ) : contacts.isError && items.length === 0 ? (
          <QueryStatePanel
            error={contacts.error}
            onRetry={() => void contacts.refetch()}
            retrying={contacts.isFetching}
            subject="your contacts"
            headingLevel={compact ? 3 : 2}
          />
        ) : items.length === 0 ? (
          <EmptyState q={q} onAdd={openCreate} compact={compact} />
        ) : (
          <ul
            aria-label="Contacts"
            className={`${contactRowsList} ${compact ? 'min-h-0 overflow-auto' : ''}`}
          >
            {items.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                compact={compact}
                active={contact.id === activeId}
              />
            ))}
            <li ref={sentinel} aria-hidden="true" className="h-px" />
          </ul>
        )}
      </Reveal>

      {contacts.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            onClick={contacts.isFetchingNextPage ? undefined : () => void contacts.fetchNextPage()}
            aria-disabled={contacts.isFetchingNextPage}
            aria-busy={contacts.isFetchingNextPage}
          >
            Load more
          </Button>
        </div>
      ) : null}
      {contacts.isError && items.length > 0 ? (
        <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
          We could not load more contacts. Try again.
        </p>
      ) : null}

      <CreateContactDialog open={creating} onOpenChange={setCreating} returnFocus={returnFocus} />
    </Panel>
  );
}

interface EmptyStateProps {
  q: string;
  onAdd: () => void;
  compact: boolean;
}

function EmptyState({ q, onAdd, compact }: EmptyStateProps) {
  if (q) {
    return (
      <p className="p-2 text-[14px] text-[color:var(--muted)]">{`No contacts match "${q}".`}</p>
    );
  }
  return (
    <StatePanel
      kind="empty"
      title="No contacts yet"
      body="Add one, or import a CSV."
      headingLevel={compact ? 3 : 2}
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={onAdd}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            Add contact
          </Button>
          {compact ? null : (
            <Link to={CONTACTS_IMPORT_PATH} className={`${textPill} h-10`}>
              <FileUp size={15} strokeWidth={1.75} aria-hidden="true" />
              Import CSV
            </Link>
          )}
        </div>
      }
    />
  );
}

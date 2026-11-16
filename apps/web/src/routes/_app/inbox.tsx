import { Panel, Reveal, Skeleton } from '@knoqra/ui';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { FormAlert } from '../../components/form-alert';
import { InboxPageSkeleton } from '../../components/inbox/inbox-skeletons';
import { TemplatesDialog } from '../../components/inbox/templates-dialog';
import { ThreadList } from '../../components/inbox/thread-list';
import { ThreadView } from '../../components/inbox/thread-view';
import { type InboxFilter, useOpenConversation } from '../../lib/inbox';

interface InboxSearch {
  thread?: string;
  filter?: InboxFilter;
  contact?: string;
  channel?: 'sms' | 'whatsapp';
}

const FILTERS: readonly InboxFilter[] = ['all', 'unread', 'sms', 'whatsapp'];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

export function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
  const thread = text(search.thread);
  const contact = text(search.contact);
  const filter = FILTERS.find((value) => value === search.filter);
  const channel =
    search.channel === 'sms' || search.channel === 'whatsapp' ? search.channel : undefined;
  return {
    ...(thread ? { thread } : {}),
    ...(filter && filter !== 'all' ? { filter } : {}),
    ...(contact ? { contact } : {}),
    ...(channel ? { channel } : {}),
  };
}

export const Route = createFileRoute('/_app/inbox')({
  staticData: { title: 'Inbox' },
  validateSearch: validateInboxSearch,
  component: InboxPage,
  pendingComponent: InboxPageSkeleton,
});

/**
 * Opens `?contact=&channel=` once, then swaps the address for `?thread=`. On failure the link
 * params go (the filter stays) and the page says so; returns whether the last attempt failed.
 */
function useOpenFromLink(
  contact: string | undefined,
  channel: 'sms' | 'whatsapp' | undefined,
  thread: string | undefined,
): boolean {
  const navigate = useNavigate({ from: Route.fullPath });
  const open = useOpenConversation();
  const started = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!contact || !channel) return;
    const key = `${contact}:${channel}`;
    if (started.current === key) return;
    started.current = key;
    setFailed(false);
    open.mutate(
      { contactId: contact, channel },
      {
        onSuccess: (conversation) =>
          void navigate({
            search: (prev) => ({
              ...(prev.filter ? { filter: prev.filter } : {}),
              thread: conversation.id,
            }),
            replace: true,
          }),
        onError: () => {
          setFailed(true);
          void navigate({
            search: (prev) => (prev.filter ? { filter: prev.filter } : {}),
            replace: true,
          });
        },
      },
    );
  }, [contact, channel, open, navigate]);
  // Once another thread is open the failure is old news; going back should not show it again.
  useEffect(() => {
    if (thread) setFailed(false);
  }, [thread]);
  return failed;
}

function InboxPage() {
  const { thread, filter = 'all', contact, channel } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const openFailed = useOpenFromLink(contact, channel, thread);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templatesReturn = useRef<() => HTMLElement | null>(() => null);
  const openTemplates = (returnFocus: () => HTMLElement | null) => {
    templatesReturn.current = returnFocus;
    setTemplatesOpen(true);
  };

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
      <ThreadList
        filter={filter}
        selectedId={thread}
        onOpenTemplates={openTemplates}
        onFilterChange={(next) =>
          void navigate({
            search: (prev) => ({
              ...(prev.thread ? { thread: prev.thread } : {}),
              ...(next === 'all' ? {} : { filter: next }),
            }),
            replace: true,
          })
        }
        onSelect={(id) =>
          void navigate({
            search: (prev) => ({ ...(prev.filter ? { filter: prev.filter } : {}), thread: id }),
          })
        }
      />
      {thread ? (
        // Keyed so another thread starts with a fresh composer, tab and scroll position.
        <ThreadView key={thread} conversationId={thread} onManageTemplates={openTemplates} />
      ) : (
        <Panel
          aria-label="Conversation"
          className="flex min-h-[240px] flex-col items-center justify-center gap-4 p-8 text-[15px] text-[color:var(--muted)]"
        >
          {openFailed ? (
            <FormAlert message="Could not open this conversation. Try again from the contact." />
          ) : contact && channel ? (
            <Reveal loading>
              <Skeleton lines={2} widths={[50, 35]} label="Opening conversation" />
            </Reveal>
          ) : (
            'Pick a conversation.'
          )}
        </Panel>
      )}
      <TemplatesDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
        // The opener can be gone by then (a new template replaces the empty state): fall back to main.
        returnFocus={() => templatesReturn.current() ?? document.getElementById('main')}
      />
    </div>
  );
}

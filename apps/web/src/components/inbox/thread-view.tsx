import { Avatar, Button, Panel } from '@knoqra/ui';
import { Link } from '@tanstack/react-router';
import { MessageCircle, MessageSquare } from 'lucide-react';
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { gradientFor } from '../../lib/contacts';
import { type ConversationDetail, useConversation, useMarkRead } from '../../lib/inbox';
import { CHANNEL_LABEL } from '../../lib/inbox-format';
import { focusRing } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { PageRibbon } from '../shell/ribbon';
import { Composer } from './composer';
import { ComposerBridge, useComposerBridge } from './composer-bridge';
import { InboxRibbon } from './inbox-ribbon';
import { RibbonSkeleton, ThreadViewSkeleton } from './inbox-skeletons';
import { ThreadMessages } from './thread-messages';

const NOW_REFRESH_MS = 30_000;

export interface ThreadViewProps {
  conversationId: string;
  onManageTemplates: (returnFocus: () => HTMLElement | null) => void;
}

/** The open conversation: header, messages oldest first, composer, and its context ribbon. */
export function ThreadView({ conversationId, onManageTemplates }: ThreadViewProps) {
  const conversation = useConversation(conversationId);
  const now = useNow(NOW_REFRESH_MS);
  useMarkReadWhileOpen(conversationId, conversation.data, conversation.dataUpdatedAt);

  if (conversation.isPending) {
    return (
      <>
        <ThreadViewSkeleton />
        <PageRibbon label="Contact">
          <RibbonSkeleton />
        </PageRibbon>
      </>
    );
  }
  // A failed background refresh keeps its data, so only a first load can end up here.
  if (conversation.data === undefined) {
    const missing = conversation.error instanceof ApiError && conversation.error.status === 404;
    return (
      <Panel
        aria-label="Conversation"
        className="flex flex-col items-start justify-center gap-4 p-8"
      >
        <p role="alert" className="font-medium text-[15px]">
          {missing
            ? "This conversation doesn't exist or isn't in your workspace."
            : 'We could not load this conversation.'}
        </p>
        {missing ? null : (
          <Button variant="primary" onClick={() => void conversation.refetch()}>
            Try again
          </Button>
        )}
      </Panel>
    );
  }

  const data = conversation.data;
  return (
    <ComposerBridge key={conversationId}>
      <DropZone enabled={data.channel === 'whatsapp'}>
        <ThreadHeader conversation={data} />
        <ThreadMessages conversationId={conversationId} now={now} />
        <Composer conversation={data} onManageTemplates={onManageTemplates} />
        <PageRibbon label="Contact">
          <InboxRibbon conversation={data} now={now} />
        </PageRibbon>
      </DropZone>
    </ComposerBridge>
  );
}

/** The conversation panel; on WhatsApp, a file dropped on it goes to the composer. */
function DropZone({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const bridge = useComposerBridge();
  const [over, setOver] = useState(false);
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  return (
    <Panel
      aria-label="Conversation"
      className="relative flex min-h-[560px] min-w-0 flex-col overflow-hidden lg:max-h-[calc(100dvh_-_2_*_var(--page-pad,0px)_-_6rem)]"
      onDragOver={(event) => {
        if (!enabled || !hasFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        if (!enabled) return;
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) bridge.setDropped(file);
      }}
    >
      {children}
      {over ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-[22px] border-2 border-[color:var(--line)] border-dashed bg-[color:var(--page)] font-medium text-[15px] opacity-90"
        >
          Drop to attach
        </div>
      ) : null}
    </Panel>
  );
}

/**
 * Marks the thread read when it opens, and again whenever a refresh shows unread messages. One
 * attempt per fetched version of the conversation, so a failing request does not loop.
 */
function useMarkReadWhileOpen(
  conversationId: string,
  data: ConversationDetail | undefined,
  updatedAt: number,
) {
  const { mutate } = useMarkRead(conversationId);
  const attemptedAt = useRef<number | null>(null);
  const opened = useRef(false);
  const unread = data?.unreadCount ?? 0;
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded || attemptedAt.current === updatedAt) return;
    if (opened.current && unread === 0) return;
    attemptedAt.current = updatedAt;
    opened.current = true;
    mutate();
  }, [loaded, unread, updatedAt, mutate]);
}

function ThreadHeader({ conversation }: { conversation: ConversationDetail }) {
  const { contact, channel } = conversation;
  const ChannelIcon = channel === 'whatsapp' ? MessageCircle : MessageSquare;
  return (
    <div className="flex items-center gap-3 px-[18px] pt-4 pb-3">
      <Avatar name={contact.displayName} gradient={gradientFor(contact.id)} size={44} />
      <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <h2 className="min-w-0 truncate font-[family-name:var(--font-display)] font-medium text-[20px] leading-[1.1] tracking-[-0.01em]">
          <Link
            to="/contacts/$contactId"
            params={{ contactId: contact.id }}
            className={`rounded-[6px] hover:underline ${focusRing}`}
          >
            {contact.displayName}
          </Link>
          {contact.company ? (
            <span className="text-[color:var(--muted)]">{` · ${contact.company}`}</span>
          ) : null}
        </h2>
        <p className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-[24px] items-center gap-[6px] rounded-full bg-[color:var(--cell)] px-[9px] font-medium text-[11px] leading-none">
            <ChannelIcon size={12} strokeWidth={1.75} aria-hidden="true" />
            {CHANNEL_LABEL[channel]}
          </span>
          <span className="font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
            {contact.phone}
          </span>
        </p>
      </div>
    </div>
  );
}

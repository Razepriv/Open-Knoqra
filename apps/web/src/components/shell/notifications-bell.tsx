import { Reveal } from '@knoqra/ui';
import * as Popover from '@radix-ui/react-popover';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '../../lib/format';
import {
  type AppNotification,
  badgeLabel,
  useMarkAllRead,
  useMarkRead,
  useNotifications,
} from '../../lib/notifications';
import { focusRing, iconPill, menuSurface } from '../../lib/ui-classes';
import { useNow } from '../../lib/use-now';
import { BellListSkeleton } from '../skeletons/overlay-skeletons';
import { useToast } from '../use-toast';

const NOW_REFRESH_MS = 30_000;
const UPDATE_FAILED = "Couldn't update notifications. Try again.";

const ROW_CLASS = `flex w-full items-start gap-3 rounded-[14px] px-3 py-2.5 text-left text-[14px] hover:bg-[color:var(--pressed)] ${focusRing}`;

function Row({
  item,
  now,
  onOpen,
}: {
  item: AppNotification;
  now: Date;
  onOpen: (item: AppNotification) => void;
}) {
  const unread = item.readAt === null;
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`mt-1.5 size-2 shrink-0 rounded-full ${unread ? 'bg-[color:var(--accent)]' : 'bg-transparent'}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`truncate ${unread ? 'font-semibold' : 'font-medium'}`}>{item.title}</span>
        <span className="text-[12px] text-[color:var(--muted)]">
          {relativeTime(item.createdAt, now)}
          {unread ? <span className="sr-only">, unread</span> : null}
        </span>
      </span>
    </>
  );
  if (item.refType === 'task') {
    return (
      <Link to="/tasks" onClick={() => onOpen(item)} className={ROW_CLASS}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(item)} className={ROW_CLASS}>
      {content}
    </button>
  );
}

function PanelBody({ onClose, onRead }: { onClose: () => void; onRead: (id: string) => void }) {
  const feed = useNotifications();
  const now = useNow(NOW_REFRESH_MS);
  const items = feed.data?.items ?? [];

  const open = (item: AppNotification) => {
    if (item.readAt === null) onRead(item.id);
    onClose();
  };

  if (feed.isError && !feed.data) {
    return (
      <p role="alert" className="px-3 py-2 text-[13px] text-[color:var(--danger-text)]">
        We could not load your notifications.
      </p>
    );
  }
  return (
    <Reveal loading={feed.isPending}>
      {feed.isPending ? (
        <BellListSkeleton />
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-[14px] text-[color:var(--muted)]">You're all caught up.</p>
      ) : (
        <ul className="m-0 flex max-h-80 list-none flex-col overflow-auto p-0">
          {items.map((item) => (
            <li key={item.id}>
              <Row item={item} now={now} onOpen={open} />
            </li>
          ))}
        </ul>
      )}
    </Reveal>
  );
}

/** The bell in the top bar: an unread badge and a popover with the latest notifications. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const feed = useNotifications();
  const markAll = useMarkAllRead();
  // Lives here, not in the panel: the panel unmounts on click, and an unmounted observer
  // drops its per-call callbacks, so a failure would go unreported.
  const markRead = useMarkRead();
  const { show, toast } = useToast();
  const unread = feed.data?.unreadCount ?? 0;
  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label={label}
          title="Notifications"
          className={`${iconPill} relative size-[42px]`}
        >
          <Bell size={17} strokeWidth={1.75} aria-hidden="true" />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[color:var(--accent)] px-1 font-semibold text-[10px] text-[color:var(--on-accent)] leading-none"
            >
              {badgeLabel(unread)}
            </span>
          ) : null}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            aria-label="Notifications"
            className={`${menuSurface} w-[min(360px,calc(100vw-24px))] p-2`}
          >
            <div className="flex items-center justify-between px-3 pt-1 pb-2">
              <h2 className="font-[family-name:var(--font-display)] text-[18px] leading-none">
                Notifications
              </h2>
              <button
                type="button"
                disabled={unread === 0 || markAll.isPending}
                onClick={() => markAll.mutate(undefined, { onError: () => show(UPDATE_FAILED) })}
                className={`cursor-pointer rounded-full px-2 py-1 font-medium text-[13px] disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
              >
                Mark all read
              </button>
            </div>
            <PanelBody
              onClose={() => setOpen(false)}
              onRead={(id) => markRead.mutate(id, { onError: () => show(UPDATE_FAILED) })}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {toast}
    </>
  );
}

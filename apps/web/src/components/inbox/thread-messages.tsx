import { Button, Reveal } from '@knoqra/ui';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { type ThreadItem, useThreadItems } from '../../lib/inbox';
import { threadDayGroups } from '../../lib/inbox-format';
import { ThreadMessagesSkeleton } from './inbox-skeletons';
import { ThreadItemView } from './thread-item';

/** How close to the bottom (px) still counts as "reading the latest", so new messages follow. */
const STICK_DISTANCE = 120;

interface Entry {
  key: string;
  occurredAt: string;
  item: ThreadItem;
}

function toEntry(item: ThreadItem): Entry {
  return item.kind === 'message'
    ? { key: item.message.id, occurredAt: item.message.occurredAt, item }
    : { key: item.note.id, occurredAt: item.note.occurredAt, item };
}

export interface ThreadMessagesProps {
  conversationId: string;
  now: Date;
}

/** The thread, oldest at the top, grouped by day, with older pages loaded on request. */
export function ThreadMessages({ conversationId, now }: ThreadMessagesProps) {
  const query = useThreadItems(conversationId);
  // Pages arrive newest first; the thread reads oldest first.
  const entries = useMemo(
    () => (query.data?.pages.flatMap((page) => page.items) ?? []).map(toEntry).reverse(),
    [query.data],
  );
  const groups = useMemo(() => threadDayGroups(entries, now), [entries, now]);
  const scroller = useStickToLatest(entries);

  return (
    <div
      ref={scroller}
      className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-auto px-[18px] py-4"
    >
      <Reveal loading={query.isPending}>
        {query.isPending ? (
          <ThreadMessagesSkeleton />
        ) : query.isError && entries.length === 0 ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="font-medium text-[15px]">We could not load the messages.</p>
            <Button variant="primary" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="m-auto text-[14px] text-[color:var(--muted)]">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-[10px]">
            {query.hasNextPage ? (
              <Button
                variant="ghost"
                className="h-8 self-center px-3 text-[12.5px]"
                onClick={query.isFetchingNextPage ? undefined : () => void query.fetchNextPage()}
                aria-busy={query.isFetchingNextPage}
              >
                Load earlier
              </Button>
            ) : null}
            {query.isFetchNextPageError ? (
              <p role="alert" className="text-center text-[13px] text-[color:var(--danger-text)]">
                We could not load earlier messages. Try again.
              </p>
            ) : null}
            {groups.map((group) => (
              <section
                key={`${group.label}-${group.events[0]?.key}`}
                aria-label={group.label}
                className="flex flex-col gap-[10px]"
              >
                <h3 className="flex h-[26px] items-center self-center rounded-full bg-[color:var(--cell)] px-3 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
                  {group.label}
                </h3>
                <ol className="flex flex-col gap-[10px]">
                  {group.events.map((entry) => (
                    <ThreadItemView key={entry.key} item={entry.item} />
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </Reveal>
    </div>
  );
}

/**
 * Keeps the newest message in view: on first load, and when one arrives while the reader is near
 * the bottom. When earlier messages load above, the reader's place is kept instead.
 */
function useStickToLatest(entries: readonly Entry[]) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = entries.at(-1)?.key;
  const oldest = entries[0]?.key;
  const previous = useRef<{ latest?: string; oldest?: string; height: number; top: number }>({
    height: 0,
    top: 0,
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const before = previous.current;
    const nearBottom = before.height - before.top - node.clientHeight < STICK_DISTANCE;
    if (latest !== before.latest && (before.latest === undefined || nearBottom)) {
      node.scrollTop = node.scrollHeight;
    } else if (oldest !== before.oldest && latest === before.latest) {
      // Earlier messages were added above: keep the same message under the reader's eye.
      node.scrollTop = before.top + (node.scrollHeight - before.height);
    }
    previous.current = { latest, oldest, height: node.scrollHeight, top: node.scrollTop };
  }, [latest, oldest]);

  // Track the reader's position between renders, so the next update knows where they were.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onScroll = () => {
      previous.current = { ...previous.current, height: node.scrollHeight, top: node.scrollTop };
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  return ref;
}

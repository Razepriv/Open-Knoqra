import { Avatar } from '@knoqra/ui';
import { MessageCircle, MessageSquare } from 'lucide-react';
import { gradientFor } from '../../lib/contacts';
import type { Conversation } from '../../lib/inbox';
import { CHANNEL_LABEL, type StateTone, threadState } from '../../lib/inbox-format';
import { focusRing } from '../../lib/ui-classes';

export interface ThreadRowProps {
  conversation: Conversation;
  selected: boolean;
  now: Date;
  onSelect: (id: string) => void;
}

const DOT: Record<StateTone, string> = {
  ok: 'var(--dot-ok)',
  warn: 'var(--dot-warn)',
  bad: 'var(--dot-bad)',
};

const chip =
  'inline-flex h-[26px] items-center gap-[6px] rounded-full bg-[color:var(--cell)] px-[9px] font-medium text-[11px] leading-none';

/** A short time for the row: the clock today, the weekday this week, else the date. */
export function rowTime(value: string, now: Date): string {
  const date = new Date(value);
  const ageMs = now.getTime() - date.getTime();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  if (ageMs < 6 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

/** One conversation in the list. A button: choosing it sets `?thread=`. */
export function ThreadRow({ conversation, selected, now, onSelect }: ThreadRowProps) {
  const { contact, channel, composer } = conversation;
  const state = threadState(channel, composer, now);
  const ChannelIcon = channel === 'whatsapp' ? MessageCircle : MessageSquare;
  const preview = conversation.lastMessagePreview
    ? `${conversation.lastMessageDirection === 'outbound' ? 'You: ' : ''}${conversation.lastMessagePreview}`
    : 'No messages yet';
  const unread = conversation.unreadCount > 0;

  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(conversation.id)}
        className={`flex w-full cursor-pointer flex-col gap-[9px] rounded-[20px] border border-[color:var(--pillBorder)] p-3 text-left ${focusRing} ${
          selected
            ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
            : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]'
        }`}
      >
        <span className="flex w-full items-center gap-[10px]">
          <Avatar name={contact.displayName} gradient={gradientFor(contact.id)} size={36} />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span
              className={`truncate text-[14px] leading-[1.1] ${unread ? 'font-bold' : 'font-semibold'}`}
            >
              {contact.displayName}
            </span>
            <span className="truncate text-[12px] text-[color:var(--muted)] leading-none">
              {contact.company ?? 'No company'}
            </span>
          </span>
          <span className="shrink-0 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
            {rowTime(conversation.lastActivityAt, now)}
          </span>
        </span>
        <span className="line-clamp-2 text-[13px] leading-[1.4]">{preview}</span>
        <span className="flex w-full items-center gap-[6px]">
          <span className={chip}>
            <ChannelIcon size={12} strokeWidth={1.75} aria-hidden="true" />
            {CHANNEL_LABEL[channel]}
          </span>
          <span className={chip}>
            <span
              aria-hidden="true"
              className="size-[6px] rounded-full"
              style={{ background: DOT[state.tone] }}
            />
            {state.label}
          </span>
          <span className="flex-1" />
          {unread ? (
            <span
              role="img"
              aria-label="Unread"
              className="size-[9px] rounded-full bg-[color:var(--line)]"
            />
          ) : null}
        </span>
      </button>
    </li>
  );
}

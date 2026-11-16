import * as Popover from '@radix-ui/react-popover';
import { CornerUpLeft, Lock, RotateCw, SmilePlus, X } from 'lucide-react';
import {
  type Message,
  type ThreadItem,
  unsentSend,
  useDiscardUnsent,
  useSendMessage,
  useSetReaction,
} from '../../lib/inbox';
import { isOptimistic } from '../../lib/inbox-cache';
import { QUICK_REACTIONS, quoteText, statusMeta } from '../../lib/inbox-format';
import { focusRing, iconPill, menuSurface } from '../../lib/ui-classes';
import { AttachmentView } from './attachment-view';
import { useComposerBridge } from './composer-bridge';

const CHANNEL_CAPS: Record<Message['channel'], string> = { sms: 'SMS', whatsapp: 'WHATSAPP' };

const meta =
  'font-[family-name:var(--font-mono)] font-medium text-[10.5px] leading-[1.3] tracking-[.02em]';

/** A 24 h clock time, such as "09:41", in the reader's own zone (or `timeZone`). */
export function clockTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(value));
}

/** `09:41 · SMS` for inbound; `TEMPLATE NAME · 09:41 · DELIVERED` for outbound. */
export function messageMeta(message: Message, timeZone?: string): string {
  const time = clockTime(message.occurredAt, timeZone);
  if (message.direction === 'inbound') return `${time} · ${CHANNEL_CAPS[message.channel]}`;
  const template = message.templateName ? `TEMPLATE ${message.templateName.toUpperCase()} · ` : '';
  return `${template}${time} · ${statusMeta(message.status, message.error)}`;
}

/** The quoted message above a reply. */
function ReplyQuote({ quote }: { quote: NonNullable<Message['replyTo']> }) {
  return (
    <div className="rounded-[12px] border-[color:currentColor] border-l-[3px] bg-[color:color-mix(in_srgb,currentColor_8%,transparent)] px-[10px] py-[6px] opacity-90">
      <p className="text-[11px] font-semibold opacity-75">
        {quote.direction === 'inbound' ? 'Contact' : 'You'}
      </p>
      <p className="line-clamp-2 text-[12.5px] leading-[1.35]">{quoteText(quote)}</p>
    </div>
  );
}

/** Reactions under a bubble: the contact's and the workspace's. */
function Reactions({ message }: { message: Message }) {
  if (message.reactions.length === 0) return null;
  return (
    <ul className="-mt-[14px] flex gap-1 self-end px-2" aria-label="Reactions">
      {message.reactions.map((r) => (
        <li
          key={r.direction}
          title={
            r.direction === 'inbound'
              ? 'Their reaction'
              : r.status === 'failed'
                ? 'Your reaction was not sent'
                : 'Your reaction'
          }
          className="rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[7px] py-[1px] text-[13px] [box-shadow:var(--pillShadow)]"
          style={r.status === 'failed' ? { opacity: 0.5 } : undefined}
        >
          {r.emoji}
        </li>
      ))}
    </ul>
  );
}

/** Reply and react, for an inbound WhatsApp message that WhatsApp lets us target. */
function MessageActions({ message }: { message: Message }) {
  const bridge = useComposerBridge();
  const react = useSetReaction(message.conversationId);
  const mine = message.reactions.find((r) => r.direction === 'outbound')?.emoji ?? null;
  return (
    <div className="flex items-center gap-1 self-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      <button
        type="button"
        onClick={() => bridge.setReplyTo(message)}
        aria-label="Reply to this message"
        className={`${iconPill} size-7`}
      >
        <CornerUpLeft size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <Popover.Root>
        <Popover.Trigger aria-label="React to this message" className={`${iconPill} size-7`}>
          <SmilePlus size={13} strokeWidth={1.75} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            sideOffset={6}
            className={`${menuSurface} flex flex-row gap-1 p-1.5`}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <Popover.Close
                key={emoji}
                onClick={() =>
                  react.mutate({ messageId: message.id, emoji: mine === emoji ? '' : emoji })
                }
                aria-label={mine === emoji ? `Remove ${emoji}` : `React ${emoji}`}
                aria-pressed={mine === emoji}
                className={`size-9 cursor-pointer rounded-full text-[18px] ${focusRing} ${mine === emoji ? 'bg-[color:var(--pressed)]' : ''}`}
              >
                {emoji}
              </Popover.Close>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/** A send that never reached the server: try again with the same id, or drop it. */
function UnsentActions({ message }: { message: Message }) {
  const send = useSendMessage(message.conversationId, message.channel);
  const discard = useDiscardUnsent(message.conversationId);
  const clientMessageId = message.clientMessageId ?? '';
  const original = unsentSend(clientMessageId);
  return (
    <div className="flex items-center gap-1 self-end">
      {original ? (
        <button
          type="button"
          onClick={() => send.mutate(original)}
          className={`${iconPill} h-7 gap-1 px-2 text-[12px]`}
        >
          <RotateCw size={12} strokeWidth={2} aria-hidden="true" />
          Retry
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => discard(clientMessageId)}
        aria-label="Remove unsent message"
        className={`${iconPill} size-7`}
      >
        <X size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** A message's files, quote and text inside its bubble. */
function BubbleContent({ message }: { message: Message }) {
  return (
    <>
      {message.replyTo ? <ReplyQuote quote={message.replyTo} /> : null}
      {message.attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} />
      ))}
      {message.body ? (
        <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.5]">{message.body}</p>
      ) : null}
    </>
  );
}

/** One message or internal note in the thread. */
export function ThreadItemView({ item }: { item: ThreadItem }) {
  if (item.kind === 'note') {
    const { note } = item;
    return (
      <li className="flex justify-end">
        <div className="flex max-w-[70%] flex-col gap-[6px] rounded-[20px] border-[1.5px] border-[color:var(--muted)] border-dashed bg-[color:var(--cell)] px-[14px] py-[11px]">
          <p className={`${meta} flex items-center gap-[5px] uppercase opacity-80`}>
            <Lock size={11} strokeWidth={2} aria-hidden="true" />
            INTERNAL ONLY · NOT SENT
          </p>
          <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.5]">{note.body}</p>
          <p className={`${meta} text-[color:var(--muted)]`}>
            {`${(note.authorName ?? 'A teammate').toUpperCase()} · ${clockTime(note.occurredAt)}`}
          </p>
        </div>
      </li>
    );
  }
  const { message } = item;
  const sticker =
    message.attachments.length === 1 && message.attachments[0]?.kind === 'sticker' && !message.body;
  if (message.direction === 'inbound') {
    return (
      <li className="group flex justify-start gap-2">
        <div className="flex max-w-[70%] flex-col gap-[6px]">
          <div
            className={
              sticker
                ? 'flex flex-col gap-[6px]'
                : 'flex flex-col gap-[6px] rounded-[20px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[14px] py-[11px]'
            }
          >
            <BubbleContent message={message} />
            <p className={`${meta} text-[color:var(--muted)]`}>{messageMeta(message)}</p>
          </div>
          <Reactions message={message} />
        </div>
        {message.replyable ? <MessageActions message={message} /> : null}
      </li>
    );
  }
  const failed = message.status === 'failed';
  const unsent = failed && isOptimistic(message);
  return (
    <li className="flex justify-end">
      <div className="flex max-w-[70%] flex-col gap-[6px]">
        <div
          className="flex flex-col gap-[6px] rounded-[20px] border px-[14px] py-[11px] text-[color:var(--on-accent)] [box-shadow:var(--shadow-tile)]"
          style={{
            background: 'var(--grad-mint)',
            borderColor: failed ? 'var(--dot-bad)' : 'transparent',
            opacity: isOptimistic(message) && !failed ? 0.85 : 1,
          }}
        >
          <BubbleContent message={message} />
          <p
            aria-live="polite"
            data-tone={failed ? 'bad' : undefined}
            className={`${meta} flex items-center gap-[6px] ${failed ? 'font-semibold' : 'opacity-75'}`}
          >
            {failed ? (
              <span
                aria-hidden="true"
                className="size-[7px] shrink-0 rounded-full"
                style={{ background: 'var(--dot-bad)' }}
              />
            ) : null}
            {unsent ? `NOT SENT · ${message.error?.message ?? ''}` : messageMeta(message)}
          </p>
        </div>
        <Reactions message={message} />
        {unsent ? <UnsentActions message={message} /> : null}
      </div>
    </li>
  );
}

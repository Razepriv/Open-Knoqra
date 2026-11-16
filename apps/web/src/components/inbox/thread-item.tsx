import { Lock } from 'lucide-react';
import type { Message, ThreadItem } from '../../lib/inbox';
import { statusMeta } from '../../lib/inbox-format';

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
  if (message.direction === 'inbound') {
    return (
      <li className="flex justify-start">
        <div className="flex max-w-[70%] flex-col gap-[6px] rounded-[20px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[14px] py-[11px]">
          <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.5]">
            {message.body}
          </p>
          <p className={`${meta} text-[color:var(--muted)]`}>{messageMeta(message)}</p>
        </div>
      </li>
    );
  }
  const failed = message.status === 'failed';
  return (
    <li className="flex justify-end">
      <div
        className="flex max-w-[70%] flex-col gap-[6px] rounded-[20px] border px-[14px] py-[11px] text-[color:var(--on-accent)] [box-shadow:var(--shadow-tile)]"
        style={{
          background: 'var(--grad-mint)',
          borderColor: failed ? 'var(--dot-bad)' : 'transparent',
        }}
      >
        <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.5]">{message.body}</p>
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
          {messageMeta(message)}
        </p>
      </div>
    </li>
  );
}

import { Clock } from 'lucide-react';
import { type ComposerState, windowLabel, windowPercent } from '../../lib/inbox-format';

export interface WindowCardProps {
  composer: ComposerState;
  now: Date;
}

/**
 * The WhatsApp 24 h service window: open (mint) with the time left, or closed (apricot), when only
 * approved templates may be sent. WhatsApp threads only.
 */
export function WindowCard({ composer, now }: WindowCardProps) {
  const expiresAt = composer.windowExpiresAt;
  const open = expiresAt !== null && new Date(expiresAt).getTime() > now.getTime();
  const percent = windowPercent(expiresAt, now);
  const title = open ? 'WhatsApp window open' : 'Window closed · templates only';
  return (
    <section
      aria-label="WhatsApp window"
      className="flex flex-col gap-2 rounded-[16px] px-[14px] py-[10px] text-[color:var(--on-accent)]"
      style={{ background: open ? 'var(--grad-mint)' : 'var(--grad-apr)' }}
    >
      <p className="flex items-center gap-2 font-semibold text-[13px] leading-[1.2]">
        <Clock size={15} strokeWidth={1.75} aria-hidden="true" />
        {title}
      </p>
      <div
        role="progressbar"
        aria-label="WhatsApp window remaining"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-[4px] bg-[color:var(--on-accent)]/15"
      >
        <div
          className="h-2 rounded-[4px] bg-[color:var(--on-accent)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="font-[family-name:var(--font-mono)] font-medium text-[11px] leading-none">
        {windowLabel(expiresAt, now).toUpperCase()}
      </p>
    </section>
  );
}

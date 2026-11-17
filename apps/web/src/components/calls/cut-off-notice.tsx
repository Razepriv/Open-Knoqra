import { CircleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { type Call, cutOffWarningCopy, formatDuration, secondsUntilCutOff } from '../../lib/calls';
import { useNow } from '../../lib/use-now';

/** The red stripe of the design's blocked state, mixed from the bad dot token. */
const warningStyle: CSSProperties = {
  background:
    'repeating-linear-gradient(135deg, color-mix(in srgb, var(--dot-bad) 22%, transparent) 0 8px, color-mix(in srgb, var(--dot-bad) 10%, transparent) 8px 16px)',
  border: '1px solid color-mix(in srgb, var(--dot-bad) 55%, transparent)',
};

/**
 * Shown on a live call the server will end because the wallet or the monthly spend cap cannot pay
 * for more minutes: why, and a countdown to the cut. The message is an alert (announced once); the
 * countdown is a timer, which screen readers do not announce on every tick. Adding credit before the
 * countdown ends keeps the call going, and the notice goes away when the server says so.
 */
export function CutOffWarning({ call, compact = false }: { call: Call; compact?: boolean }) {
  const now = useNow(1000);
  const left = secondsUntilCutOff(call, now);
  if (left === null || !call.cutOff) return null;
  return (
    <div
      style={warningStyle}
      className={`flex w-full items-start gap-2 text-left text-[color:var(--text)] ${
        compact ? 'rounded-[14px] px-3 py-2' : 'rounded-[20px] px-4 py-3'
      }`}
    >
      <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
      <p role="alert" className={`flex-1 ${compact ? 'text-[12px]' : 'text-[13px]'} leading-[1.4]`}>
        {cutOffWarningCopy(call.cutOff.reason)}
      </p>
      <span
        role="timer"
        aria-label="Time left before the call ends"
        className="font-[family-name:var(--font-mono)] font-medium text-[13px] leading-[1.4] [font-variant-numeric:tabular-nums]"
      >
        {formatDuration(left)}
      </span>
    </div>
  );
}

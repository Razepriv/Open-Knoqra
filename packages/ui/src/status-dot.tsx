import type { dot } from '@knoqra/tokens';
import { cn } from './cn';

export interface StatusDotProps {
  status: keyof typeof dot;
  label: string;
  className?: string;
}

export function StatusDot({ status, label, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 font-medium text-[13px] text-[color:var(--text)] leading-none',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-block size-2 rounded-full"
        style={{ background: `var(--dot-${status})` }}
      />
      {label}
    </span>
  );
}

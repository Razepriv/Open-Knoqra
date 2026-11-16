import { CircleAlert, CircleCheck, Clock } from 'lucide-react';
import type { CheckStatus } from '../../lib/numbers';

export const STATUS_TEXT: Record<CheckStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  pending: 'Pending',
};

const ICONS = { pass: CircleCheck, fail: CircleAlert, pending: Clock } as const;

/** An icon plus its word, so status never rests on color alone. */
export function StatusBadge({ status }: { status: CheckStatus }) {
  const Icon = ICONS[status];
  return (
    <span className="inline-flex shrink-0 items-center gap-[6px] font-[family-name:var(--font-mono)] font-medium text-[12px] uppercase leading-none tracking-[.04em]">
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      {STATUS_TEXT[status]}
    </span>
  );
}

import type { gradients } from '@knoqra/tokens';
import { cn } from './cn';

export interface AvatarProps {
  name: string;
  /** The colour wash behind the initials. Ignored when `tone` is `ink`. */
  gradient?: keyof typeof gradients;
  /** `ink` is the solid dark disc used for the signed-in account in the top bar. */
  tone?: 'gradient' | 'ink';
  size?: number;
  className?: string;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = [first, last].map((w) => (w ? Array.from(w)[0] : '')).join('');
  return letters.toUpperCase();
}

export function Avatar({
  name,
  gradient = 'cit',
  tone = 'gradient',
  size = 36,
  className,
}: AvatarProps) {
  const ink = tone === 'ink';
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none',
        ink
          ? 'border border-[color:var(--pillBorder)] text-[color:var(--streak-text)]'
          : 'text-[color:var(--on-accent)]',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: ink ? 11 : Math.max(10, Math.round(size * 0.33)),
        background: ink ? 'var(--mark-bg)' : `var(--grad-${gradient})`,
      }}
    >
      <span aria-hidden="true">{initials(name)}</span>
    </span>
  );
}

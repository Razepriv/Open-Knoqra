import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  /** md is 34px (13px text); sm is 32px with 11px padding and 12px text, for filter rows. */
  size?: 'md' | 'sm';
}

const sizes = {
  md: 'h-[34px] px-3 text-[13px]',
  sm: 'h-8 px-[11px] text-[12px]',
} as const;

export function Pill({
  pressed = false,
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: PillProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 rounded-full border border-[color:var(--pillBorder)] font-medium text-[color:var(--text)] leading-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--line)]',
        sizes[size],
        pressed
          ? 'bg-[color:var(--pressed)] [box-shadow:var(--pressedShadow)]'
          : 'bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

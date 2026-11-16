import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ButtonVariant;
  /** React 19 passes `ref` as a prop; it reaches the underlying <button>. */
  ref?: Ref<HTMLButtonElement>;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-[color:var(--accent)] text-[color:var(--on-accent)] [box-shadow:var(--shadow-button)] hover:bg-[color:var(--accent-hover)]',
  danger: 'bg-[color:var(--danger-fill)] text-[color:var(--on-accent)]',
  ghost: 'border border-[color:var(--pillBorder)] bg-transparent text-[color:var(--text)]',
};

const base =
  'inline-flex h-10 cursor-pointer items-center justify-center gap-[7px] whitespace-nowrap rounded-full px-4 font-semibold text-sm leading-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--line)]';

export function Button({ variant, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cn(base, variants[variant], className)} {...rest}>
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant: ButtonVariant;
}

/** A link that looks like a Button, for navigation (it keeps link semantics, such as open in a new tab). */
export function ButtonLink({ variant, className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={cn(base, variants[variant], className)} {...rest}>
      {children}
    </a>
  );
}

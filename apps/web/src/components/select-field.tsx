import { ChevronDown } from 'lucide-react';
import type { ReactNode, SelectHTMLAttributes } from 'react';
import { focusRing } from '../lib/ui-classes';

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}

/** A labelled native select styled like Field, so keyboard and screen readers behave natively. */
export function SelectField({ id, label, hint, className, children, ...select }: SelectFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-2 font-medium text-[13px] text-[color:var(--text)]">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-describedby={hintId}
          className={`h-12 w-full cursor-pointer appearance-none rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] pr-11 pl-4 text-[15px] text-[color:var(--text)] outline-none [box-shadow:var(--cellShadow)] ${focusRing} ${className ?? ''}`}
          {...select}
        >
          {children}
        </select>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[color:var(--muted)]"
        />
      </div>
      {hint ? (
        <p
          id={hintId}
          className="mt-2 font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-snug"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

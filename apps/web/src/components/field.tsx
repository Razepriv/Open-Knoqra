import type { InputHTMLAttributes, Ref } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  ref?: Ref<HTMLInputElement>;
}

/** A labelled input sunk into a cell, with an optional hint and inline error. */
export function Field({ id, label, hint, error, className, ...input }: FieldProps) {
  const showHint = Boolean(hint) && !error;
  const hintId = showHint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-2 font-medium text-[13px] text-[color:var(--text)]">
        {label}
        {input.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`h-12 w-full rounded-2xl border bg-[color:var(--cell)] px-4 text-[15px] text-[color:var(--text)] outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2 ${
          error ? 'border-[color:var(--danger-text)]' : 'border-[color:var(--panelBorder)]'
        } ${className ?? ''}`}
        {...input}
      />
      {showHint ? (
        <p
          id={hintId}
          className="mt-2 font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-none"
        >
          {hint}
        </p>
      ) : null}
      {/* Always mounted: screen readers only announce changes inside a live region that exists. */}
      <div aria-live="polite">
        {error ? (
          <p id={errorId} className="mt-2 text-[13px] text-[color:var(--danger-text)] leading-snug">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

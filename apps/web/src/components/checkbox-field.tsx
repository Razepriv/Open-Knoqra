import type { InputHTMLAttributes, ReactNode } from 'react';

export interface CheckboxFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  id: string;
  label: ReactNode;
  hint?: string;
  /** Shown under the label and announced; marks the input invalid. */
  error?: string | undefined;
}

/** A labelled checkbox row. The native input stays, so it is keyboard and screen-reader ready. */
export function CheckboxField({ id, label, hint, error, className, ...input }: CheckboxFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex items-start gap-3 ${className ?? ''}`}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="mt-[3px] size-[18px] shrink-0 cursor-pointer accent-[color:var(--accent)] focus-visible:outline-2 focus-visible:outline-[color:var(--line)] focus-visible:outline-offset-2 disabled:cursor-not-allowed"
        {...input}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="cursor-pointer font-medium text-[14px] leading-snug">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-[13px] text-[color:var(--muted)] leading-snug">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="text-[13px] text-[color:var(--danger)] leading-snug"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

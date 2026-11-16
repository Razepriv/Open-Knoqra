import type { InputHTMLAttributes } from 'react';

export interface CheckboxFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  id: string;
  label: string;
  hint?: string;
}

/** A labelled checkbox row. The native input stays, so it is keyboard and screen-reader ready. */
export function CheckboxField({ id, label, hint, className, ...input }: CheckboxFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={`flex items-start gap-3 ${className ?? ''}`}>
      <input
        id={id}
        type="checkbox"
        aria-describedby={hintId}
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
      </div>
    </div>
  );
}

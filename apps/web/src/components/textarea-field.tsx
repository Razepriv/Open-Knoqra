import type { TextareaHTMLAttributes } from 'react';
import { focusRing } from '../lib/ui-classes';

export interface TextareaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id: string;
  label: string;
  hint?: string;
  /** Shown under the field, right-aligned, such as "12 / 500". */
  counter?: string;
  error?: string | null;
}

/** A labelled multi-line input sunk into a cell, matching `Field`, with an optional inline error. */
export function TextareaField({
  id,
  label,
  hint,
  counter,
  error,
  className,
  ...area
}: TextareaFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const counterId = counter ? `${id}-count` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId, counterId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col">
      <label htmlFor={id} className="mb-2 font-medium text-[13px] text-[color:var(--text)]">
        {label}
        {area.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`min-h-[88px] w-full resize-y rounded-2xl border bg-[color:var(--cell)] px-4 py-3 text-[15px] text-[color:var(--text)] leading-relaxed outline-none [box-shadow:var(--cellShadow)] placeholder:text-[color:var(--muted)] ${focusRing} ${
          error ? 'border-[color:var(--danger-text)]' : 'border-[color:var(--panelBorder)]'
        } ${className ?? ''}`}
        {...area}
      />
      {hint || counter ? (
        <div className="mt-2 flex items-start justify-between gap-3 font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] leading-[1.4]">
          {hint ? <p id={hintId}>{hint}</p> : <span />}
          {counter ? (
            <p id={counterId} className="shrink-0 tabular-nums">
              {counter}
            </p>
          ) : null}
        </div>
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

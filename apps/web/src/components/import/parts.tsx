import { type ReactNode, useEffect, useRef } from 'react';

/** Small IBM Plex Mono caps label, as used across the Desk. */
export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`font-[family-name:var(--font-mono)] text-[11px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em] ${className ?? ''}`}
    >
      {children}
    </p>
  );
}

export interface StepHeadingProps {
  eyebrow: string;
  title: string;
  /** Move keyboard focus to the heading when it appears. Off for the page's first paint. */
  focusOnMount?: boolean;
  children?: ReactNode;
}

/** The step's heading. On a step change it takes focus so keyboard users land on it. */
export function StepHeading({ eyebrow, title, focusOnMount = true, children }: StepHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <div className="flex flex-col gap-3">
      <MonoLabel>{eyebrow}</MonoLabel>
      <h1
        ref={ref}
        tabIndex={-1}
        className="font-[family-name:var(--font-display)] text-[clamp(28px,3.6vw,44px)] leading-none tracking-[-0.03em] outline-none"
      >
        {title}
      </h1>
      {children ? (
        <div className="max-w-[62ch] text-[15px] text-[color:var(--muted)] leading-relaxed">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** A heads-up that does not block the import. Hatched, as the Desk marks things to check. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-2xl border border-[color:var(--panelBorder)] bg-[image:var(--hatch)] px-4 py-3 text-[14px] text-[color:var(--text)] leading-snug"
    >
      {children}
    </p>
  );
}

export const tableClasses = {
  wrap: 'overflow-x-auto rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]',
  table: 'w-full border-collapse text-left text-[13px]',
  th: 'whitespace-nowrap border-[color:var(--panelBorder)] border-b px-3 py-2 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase tracking-[.04em]',
  td: 'max-w-[28ch] truncate border-[color:var(--panelBorder)] border-b px-3 py-2 align-top last:border-b-0',
} as const;

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

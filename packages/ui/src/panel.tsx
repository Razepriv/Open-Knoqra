import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type PanelProps = HTMLAttributes<HTMLDivElement>;

export function Panel({ className, children, ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        'rounded-[30px] border border-[color:var(--panelBorder)] bg-[image:var(--panel)] text-[color:var(--text)] [box-shadow:var(--panelShadow)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

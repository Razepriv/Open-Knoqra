import { useEffect, useRef } from 'react';
import { cn } from './cn';

export interface ToastProps {
  message: string;
  onDone: () => void;
  durationMs?: number;
  className?: string;
  /**
   * `status` (default) makes the toast its own live region. Pass `none` when an always-mounted
   * live region around it does the announcing: a region added together with its text is often
   * not read.
   */
  role?: 'status' | 'none';
}

export function Toast({
  message,
  onDone,
  durationMs = 3600,
  className,
  role = 'status',
}: ToastProps) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const id = setTimeout(() => onDoneRef.current(), durationMs);
    return () => clearTimeout(id);
  }, [durationMs]);

  return (
    <div
      role={role}
      className={cn(
        'inline-flex items-center gap-[10px] rounded-full bg-[color:var(--accent)] px-[18px] py-3 font-semibold text-[color:var(--on-accent)] text-sm leading-none [box-shadow:var(--shadow-toast)] animate-[kq-rise_var(--dur-fast)_var(--ease-standard)]',
        className,
      )}
    >
      {message}
    </div>
  );
}

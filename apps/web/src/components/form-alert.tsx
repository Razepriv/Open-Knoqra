export interface FormAlertProps {
  message: string | null;
  /**
   * `error` (the default) is announced assertively as an alert. `notice` is informational, such as
   * "your session ended", and is announced politely as a status.
   */
  tone?: 'error' | 'notice';
}

/** Form-level banner announced to screen readers. */
export function FormAlert({ message, tone = 'error' }: FormAlertProps) {
  if (!message) return null;
  const announce =
    tone === 'error'
      ? { role: 'alert' as const }
      : { role: 'status' as const, 'aria-live': 'polite' as const };
  return (
    <p
      {...announce}
      className={`rounded-2xl border bg-[color:var(--cell)] px-4 py-3 text-[14px] ${
        tone === 'error'
          ? 'border-[color:var(--danger-text)]/30 text-[color:var(--danger-text)]'
          : 'border-[color:var(--panelBorder)] text-[color:var(--text)]'
      }`}
    >
      {message}
    </p>
  );
}

/** "Early access": Otto answers with the plan's free model, so it can be busy at times. */
export function EarlyAccessTag() {
  return (
    <span
      title="Otto runs on a free model while in early access, so it can be busy at times."
      className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-[color:var(--cell)] px-2 font-[family-name:var(--font-mono)] font-medium text-[10px] text-[color:var(--muted)] uppercase leading-none tracking-[.04em]"
    >
      Early access
    </span>
  );
}

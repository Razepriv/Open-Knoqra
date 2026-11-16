import { Panel } from '@knoqra/ui';
import type { ReactNode } from 'react';

export interface SettingsSectionProps {
  /**
   * The section's own id (so `/settings#<id>` opens on it) and the base of its heading id; the
   * heading names the region for screen readers.
   */
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}

/** One titled card on the Settings page. */
export function SettingsSection({ id, title, description, children }: SettingsSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <Panel className="p-6 sm:p-8">
      <section id={id} aria-labelledby={headingId} className="flex scroll-mt-6 flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2
            id={headingId}
            className="font-[family-name:var(--font-display)] text-[26px] leading-none tracking-[-0.025em]"
          >
            {title}
          </h2>
          <p className="max-w-[52ch] text-[14px] text-[color:var(--muted)] leading-relaxed">
            {description}
          </p>
        </header>
        {children}
      </section>
    </Panel>
  );
}

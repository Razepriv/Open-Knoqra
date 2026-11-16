import type { ReactNode } from 'react';

/**
 * A box that scrolls sideways (a wide table). Keyboard users can only scroll it if it can take
 * focus, and a focusable region needs a name that says what it holds.
 */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be keyboard reachable
    <section aria-label={label} tabIndex={0} className="overflow-x-auto">
      {children}
    </section>
  );
}

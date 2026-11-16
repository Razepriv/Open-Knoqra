import { AsciiReveal, type PresetName } from 'ascii-reveal';
import type { ReactNode } from 'react';
import { cn } from './cn';

export type RevealProps = {
  loading: boolean;
  children: ReactNode;
  preset?: PresetName;
  selector?: string;
  revealOnMount?: boolean;
  className?: string;
};

/**
 * Decodes real content in through a character grid once `loading` turns false.
 * The content stays in the DOM, so screen readers read the real text; reduced motion
 * becomes a fade (handled by the library).
 */
export function Reveal({
  loading,
  children,
  preset = 'decode',
  selector,
  revealOnMount,
  className,
}: RevealProps) {
  return (
    <AsciiReveal
      loading={loading}
      preset={preset}
      duration="fast"
      selector={selector}
      revealOnMount={revealOnMount}
      className={cn(
        '[--ascii-accent:var(--line)] [--ascii-font:var(--font-mono)] [--ascii-mascot:var(--line)]',
        className,
      )}
    >
      {children}
    </AsciiReveal>
  );
}

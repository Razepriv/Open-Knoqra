import { AsciiSkeleton, type SkeletonVariant } from 'ascii-reveal';
import { cn } from './cn';

export type SkeletonProps = {
  variant?: SkeletonVariant;
  lines?: number;
  /** Line widths: a number is a percentage of the container, a string is any CSS length. */
  widths?: ReadonlyArray<number | string>;
  rows?: number;
  width?: number | string;
  height?: number | string;
  circle?: boolean;
  animate?: boolean;
  /** Varies the glyph pattern, so neighbouring placeholders don't look identical. */
  seed?: number;
  className?: string;
  /** What assistive tech announces once for the whole placeholder. */
  label?: string;
  /**
   * Part of a larger outline that announces itself once (see skeleton-kit): no status, no label,
   * hidden from assistive tech.
   */
  decorative?: boolean;
};

const percent = (w: number | string): string => (typeof w === 'number' ? `${w}%` : w);

/** Enough glyph rows to fill a block of this height (about 12px a row); 4 when it is not in px. */
const rowsFor = (height: number | string): number =>
  typeof height === 'number' ? Math.max(1, Math.ceil(height / 12)) : 4;

/**
 * The one loading placeholder in KNOQRA: an ASCII glyph pattern (ascii-reveal).
 * Screen readers hear a single status (the sr-only label); the glyph layer is aria-hidden by the
 * library.
 */
export function Skeleton({
  variant = 'dither',
  lines,
  widths,
  rows,
  width,
  height,
  circle,
  animate,
  seed,
  className,
  label = 'Loading',
  decorative = false,
}: SkeletonProps) {
  // A sized placeholder (width and height, no lines) is one block of that size, not three lines.
  const blockRows =
    rows ?? (lines === undefined && height !== undefined ? rowsFor(height) : undefined);
  const glyphs = (
    <AsciiSkeleton
      variant={variant}
      lines={lines}
      widths={widths?.map(percent)}
      rows={blockRows}
      width={width}
      height={height}
      circle={circle}
      animate={animate}
      seed={seed}
      className="block h-full"
    />
  );
  // overflow-hidden: the shimmer canvas starts at 300x150 and is sized only once it draws, so an
  // off-screen placeholder would otherwise widen the page.
  const look = cn(
    'block overflow-hidden [--ascii-accent:var(--line)] [--ascii-font:var(--font-mono)] [--ascii-skeleton:var(--muted)]',
    className,
  );
  if (decorative) {
    return (
      <span aria-hidden="true" className={look}>
        {glyphs}
      </span>
    );
  }
  return (
    <span role="status" aria-label={label} className={look}>
      <span className="sr-only">{label}</span>
      {glyphs}
    </span>
  );
}

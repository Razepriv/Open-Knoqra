import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { authLayout, listRow } from './layouts';
import { Panel } from './panel';
import { shellLayout } from './shell-layout';
import { Skeleton } from './skeleton';

/**
 * Layout-shaped loading outlines. Every part is the ascii-reveal glyph fill (through Skeleton), sized
 * like the control it stands in for, so the real page lands without moving. Parts are hidden from
 * assistive tech; a page-level outline announces itself once, through SkeletonStatus or a
 * SkeletonPanel/SkeletonShell/SkeletonAuth `label`. See SKELETONS.md.
 */

type Length = number | string;

const px = (value: Length): string => (typeof value === 'number' ? `${value}px` : value);

interface GlyphProps {
  width: Length;
  height: Length;
  /** `circle` for avatars, `pill` for buttons and chips, otherwise softly rounded. */
  shape?: 'circle' | 'pill' | 'soft';
  seed?: number;
  className?: string;
}

const shapes = {
  circle: '[--ars-radius:50%]',
  pill: '[--ars-radius:999px]',
  soft: '[--ars-radius:6px]',
} as const;

/**
 * One glyph block of an exact size: the unit every other part is built from. The box carries the
 * size, so a percentage width resolves against the line it sits in, even inside a flex row.
 */
function Glyph({ width, height, shape = 'soft', seed, className }: GlyphProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('block max-w-full shrink-0', shapes[shape], className)}
      style={{ width: px(width), height: px(height) }}
    >
      <Skeleton
        decorative
        rows={4}
        width="100%"
        height="100%"
        seed={seed}
        className="h-full text-[10px] leading-none"
      />
    </span>
  );
}

/** The one announcement of a page-level outline. Visually hidden. */
export function SkeletonStatus({ label }: { label: string }) {
  return (
    <span role="status" aria-label={label} className="sr-only">
      {label}
    </span>
  );
}

export interface SkeletonPanelProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  children?: ReactNode;
  /** Set on the page-level panel only: it becomes the outline's single status. */
  label?: string;
}

/** A Panel surface holding skeleton parts, with an optional status label. */
export function SkeletonPanel({ className, children, label, ...rest }: SkeletonPanelProps) {
  return (
    <Panel className={className} aria-hidden={label ? undefined : true} {...rest}>
      {label ? <SkeletonStatus label={label} /> : null}
      {children}
    </Panel>
  );
}

export interface SkeletonAvatarProps {
  size?: number;
  seed?: number;
  className?: string;
}

/** A round avatar, 36px unless told otherwise. */
export function SkeletonAvatar({ size = 36, seed, className }: SkeletonAvatarProps) {
  return (
    <span
      aria-hidden="true"
      data-skeleton-part="avatar"
      className={cn('block shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Glyph width="100%" height="100%" shape="circle" seed={seed} />
    </span>
  );
}

export type SkeletonButtonSize = 'md' | 'sm' | 'icon' | 'lg';

export interface SkeletonButtonProps {
  width?: Length;
  size?: SkeletonButtonSize;
  /** For a control off the standard sizes (a 34px text pill, a 40px icon pill). */
  height?: number;
  className?: string;
}

const buttonHeights: Record<SkeletonButtonSize, number> = { lg: 48, md: 40, sm: 32, icon: 42 };
const buttonWidths: Record<SkeletonButtonSize, number> = { lg: 160, md: 120, sm: 96, icon: 42 };

/** A pill button: 40px (md), 32px (sm), 48px (lg) or a 42px round icon pill. */
export function SkeletonButton({
  width,
  size = 'md',
  height: heightOverride,
  className,
}: SkeletonButtonProps) {
  const height = heightOverride ?? buttonHeights[size];
  const style: CSSProperties = {
    width: size === 'icon' ? height : px(width ?? buttonWidths[size]),
    height,
  };
  if (size === 'icon') {
    return (
      <span
        aria-hidden="true"
        data-skeleton-part="button"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]',
          className,
        )}
        style={style}
      >
        <Glyph width={17} height={17} shape="circle" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-skeleton-part="button"
      className={cn('block shrink-0', className)}
      style={style}
    >
      <Glyph width="100%" height="100%" shape="pill" />
    </span>
  );
}

export interface SkeletonFieldProps {
  label?: boolean;
  /** The mono hint line under the field. */
  hint?: boolean;
  width?: Length;
  className?: string;
}

/** A form field: its label line, then the 48px sunken field outline (as Field draws it). */
export function SkeletonField({
  label = true,
  hint = false,
  width,
  className,
}: SkeletonFieldProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex flex-col', className)}
      style={width === undefined ? undefined : { width: px(width) }}
    >
      {label ? (
        <span data-skeleton-part="field-label" className="mb-2 flex h-[19.5px] items-center">
          <Glyph width="30%" height={11} />
        </span>
      ) : null}
      <span
        data-skeleton-part="field"
        className="flex h-12 items-center rounded-2xl border border-[color:var(--panelBorder)] bg-[color:var(--cell)] px-4 [box-shadow:var(--cellShadow)]"
      >
        <Glyph width="42%" height={12} />
      </span>
      {hint ? (
        <span className="mt-2 flex h-[11px] items-center">
          <Glyph width="55%" height={9} />
        </span>
      ) : null}
    </span>
  );
}

export type SkeletonTextSize = 'display' | 'title' | 'body' | 'mono';

/** Line box and glyph height for each step of the type scale. */
const textSizes: Record<SkeletonTextSize, { box: number; glyph: number }> = {
  display: { box: 44, glyph: 30 },
  title: { box: 26, glyph: 18 },
  body: { box: 21, glyph: 11 },
  mono: { box: 11, glyph: 9 },
};

export interface SkeletonTextProps {
  lines?: number;
  /** Width per line, cycled. A number is a percentage. */
  widths?: ReadonlyArray<Length>;
  size?: SkeletonTextSize;
  /** Overrides the line box height (any CSS length), for type set outside the scale. */
  lineHeight?: Length;
  /** Where the glyphs sit on the line, for centred or right-aligned text. */
  align?: 'start' | 'center' | 'end';
  seed?: number;
  className?: string;
}

const defaultWidths: ReadonlyArray<Length> = [92, 78, 86, 60];

const lineAlign = { start: 'justify-start', center: 'justify-center', end: 'justify-end' } as const;

/** Lines of text whose boxes match the type scale, so a paragraph keeps its height. */
export function SkeletonText({
  lines = 1,
  widths = defaultWidths,
  size = 'body',
  lineHeight,
  align = 'start',
  seed = 1,
  className,
}: SkeletonTextProps) {
  const { box, glyph } = textSizes[size];
  const boxHeight = lineHeight === undefined ? box : lineHeight;
  return (
    <span aria-hidden="true" className={cn('flex min-w-0 flex-col', className)}>
      {Array.from({ length: lines }, (_, i) => {
        const w = widths[i % widths.length] ?? 80;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of placeholder lines
            key={i}
            data-skeleton-part="line"
            className={cn('flex items-center', lineAlign[align])}
            style={{ height: px(boxHeight) }}
          >
            <Glyph
              width={typeof w === 'number' ? `${w}%` : w}
              height={lineHeight === undefined ? glyph : `calc(${px(boxHeight)} * ${glyph / box})`}
              seed={seed + i}
            />
          </span>
        );
      })}
    </span>
  );
}

export interface SkeletonRowProps {
  avatar?: boolean;
  avatarSize?: number;
  lines?: 1 | 2;
  trailing?: 'pill' | 'dot' | 'none';
  /** `card` is the bordered pill row (contact and task lists); `plain` has no surface. */
  surface?: 'card' | 'plain';
  seed?: number;
  className?: string;
}

/** Name and second-line widths: about as long as a name and a company. */
const rowWidths: ReadonlyArray<readonly [string, string]> = [
  ['7.5rem', '6rem'],
  ['6.5rem', '7.5rem'],
  ['8.5rem', '5rem'],
  ['6rem', '6.5rem'],
];

/** A list row: circle, one or two text lines and an optional trailing pill or dot. */
export function SkeletonRow({
  avatar = true,
  avatarSize = 36,
  lines = 2,
  trailing = 'none',
  surface = 'card',
  seed = 0,
  className,
}: SkeletonRowProps) {
  const [first, second] = rowWidths[seed % rowWidths.length] ?? ['55%', '35%'];
  return (
    <span
      aria-hidden="true"
      data-skeleton-part="row"
      className={cn(
        'flex items-center gap-[10px]',
        surface === 'card' && `${listRow.frame} ${listRow.rest}`,
        className,
      )}
    >
      {avatar ? <SkeletonAvatar size={avatarSize} seed={seed + 3} /> : null}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex h-[15px] items-center">
          <Glyph width={first} height={12} seed={seed + 1} />
        </span>
        {lines === 2 ? (
          <span className="flex h-3 items-center">
            <Glyph width={second} height={10} seed={seed + 2} />
          </span>
        ) : null}
      </span>
      {trailing === 'pill' ? <Glyph width={96} height={12} shape="pill" /> : null}
      {trailing === 'dot' ? <Glyph width={8} height={8} shape="circle" /> : null}
    </span>
  );
}

/** A round outlined control (rail item, top-bar button) with a glyph where its icon sits. */
function IconCircle({ className, part }: { className: string; part?: string }) {
  return (
    <span
      data-skeleton-part={part}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]',
        className,
      )}
    >
      <Glyph width={18} height={18} shape="circle" />
    </span>
  );
}

/** The brand tile on the rail and the narrow top bar. */
function MarkTile({ size }: { size: number }) {
  return (
    <span
      className="block shrink-0 overflow-hidden rounded-[15px]"
      style={{ width: size, height: size }}
    >
      <Glyph width="100%" height="100%" className="[--ars-radius:15px]" />
    </span>
  );
}

export interface SkeletonShellProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** A ribbon column at 1280px and up: `true` for a plain panel, or the ribbon's own outline. */
  ribbon?: boolean | ReactNode;
  /** Circles on the rail: the pages plus Settings. */
  railItems?: number;
  /** Width of the page title in the top bar. */
  titleWidth?: number;
  label?: string;
}

function RibbonOutline() {
  return (
    <SkeletonPanel className="flex flex-1 flex-col gap-4 p-[18px]">
      <SkeletonText size="title" widths={[45]} lineHeight={18} />
      <SkeletonRow surface="plain" lines={2} />
      <SkeletonRow surface="plain" lines={2} seed={1} />
    </SkeletonPanel>
  );
}

/**
 * The Desk frame while a signed-in page loads: rail, top bar (title, workspace chip, icon pills),
 * the page slot in the one <main>, and the ribbon column. Same grid and breakpoints as AppShell.
 */
export function SkeletonShell({
  children,
  ribbon = false,
  railItems = 7,
  titleWidth = 120,
  label,
  className,
  ...rest
}: SkeletonShellProps) {
  const hasRibbon = ribbon !== false && ribbon !== null && ribbon !== undefined;
  const pages = Math.max(0, railItems - 1);
  return (
    <div className={cn(shellLayout.frame, className)} {...rest}>
      <div aria-hidden="true" data-skeleton-part="rail" className={shellLayout.rail}>
        <span className="hidden lg:flex">
          <MarkTile size={46} />
        </span>
        <span className="hidden flex-1 lg:block" />
        {Array.from({ length: pages }, (_, i) => (
          <IconCircle
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed rail slots
            key={i}
            part="rail-circle"
            className="size-11 sm:size-[46px]"
          />
        ))}
        <span className="hidden flex-1 lg:block" />
        {railItems > 0 ? (
          <IconCircle part="rail-circle" className="size-11 sm:size-[46px]" />
        ) : null}
      </div>
      <div className={shellLayout.column}>
        <div aria-hidden="true" data-skeleton-part="top-bar" className={shellLayout.topBar}>
          <span className="lg:hidden">
            <MarkTile size={42} />
          </span>
          {/* min-w-0: on a narrow screen the title gives way, as the real one truncates. */}
          <span className="flex h-[22px] min-w-0 items-center px-2">
            <Glyph width={titleWidth} height={18} />
          </span>
          <span className="flex-1" />
          <span className="hidden h-[42px] w-[150px] shrink-0 items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 [box-shadow:var(--pillShadow)] sm:flex">
            <Glyph width="100%" height={11} />
          </span>
          {hasRibbon ? <IconCircle className="size-[42px] xl:hidden" /> : null}
          <IconCircle className="size-[42px]" />
          <IconCircle className="size-[42px]" />
          <span className="block size-[42px] shrink-0">
            <Glyph width="100%" height="100%" shape="circle" />
          </span>
        </div>
        <div
          className={cn(
            shellLayout.content,
            shellLayout.oneColumn,
            hasRibbon && shellLayout.withRibbonWide,
          )}
        >
          <main className={shellLayout.main}>
            {label ? <SkeletonStatus label={label} /> : null}
            {children}
          </main>
          {hasRibbon ? (
            <div
              data-skeleton-part="ribbon"
              className={cn('hidden xl:flex', shellLayout.ribbonAside)}
            >
              {ribbon === true ? <RibbonOutline /> : ribbon}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface SkeletonAuthProps extends HTMLAttributes<HTMLElement> {
  /** How many fields the form has, or each field's own shape (for hints). */
  fields: number | ReadonlyArray<SkeletonFieldProps>;
  /** Anything between the fields and the button (a checkbox, a "forgot password" link). */
  afterFields?: ReactNode;
  /** Anything after the button, inside the form (a "use a backup code instead" link). */
  afterButton?: ReactNode;
  /** The form title runs to a second line below 640px (a long title in the narrow card). */
  titleWraps?: boolean;
  label?: string;
}

const channelPills = [84, 70, 104] as const;

/**
 * The two-panel auth outline (as AuthLayout): brand, headline, lede and channel pills on the
 * left; the form card with its fields and primary button on the right.
 */
export function SkeletonAuth({
  fields,
  afterFields,
  afterButton,
  titleWraps = false,
  label,
  className,
  ...rest
}: SkeletonAuthProps) {
  const list: ReadonlyArray<SkeletonFieldProps> =
    typeof fields === 'number' ? Array.from({ length: fields }, () => ({})) : fields;
  return (
    <main className={cn(authLayout.grid, className)} {...rest}>
      {label ? <SkeletonStatus label={label} /> : null}
      <SkeletonPanel data-skeleton-part="auth-hero" className={authLayout.hero}>
        <span className={authLayout.heroTop}>
          <span className="flex items-center gap-3">
            <MarkTile size={46} />
            <Glyph width={86} height={16} />
          </span>
          <IconCircle className="size-[42px]" />
        </span>
        <span className={authLayout.heroCopy}>
          <SkeletonText
            lines={2}
            widths={['30rem', 'min(70%, 20rem)']}
            lineHeight="clamp(39.2px, 5.488vw, 70.56px)"
          />
          <SkeletonText lines={2} widths={['26rem', 'min(80%, 16rem)']} lineHeight={26} />
          <span className="flex flex-wrap gap-2">
            {channelPills.map((w) => (
              <span
                key={w}
                className="flex h-[34px] items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 [box-shadow:var(--pillShadow)]"
                style={{ width: w }}
              >
                <Glyph width="100%" height={12} />
              </span>
            ))}
          </span>
        </span>
      </SkeletonPanel>
      <SkeletonPanel data-skeleton-part="auth-form" className={authLayout.formPanel}>
        <span data-skeleton-part="auth-form-column" className={authLayout.formColumn}>
          <span className={authLayout.formHeading}>
            <SkeletonText size="mono" widths={[28]} />
            <span className="flex flex-col">
              <SkeletonText widths={[64]} lineHeight={30} />
              {titleWraps ? (
                <SkeletonText widths={[40]} lineHeight={30} className="sm:hidden" />
              ) : null}
            </span>
          </span>
          <span className="flex flex-col gap-5">
            {list.map((field, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fields are positional
              <SkeletonField key={i} {...field} />
            ))}
            {afterFields}
            <SkeletonButton size="lg" width="100%" />
            {afterButton}
          </span>
          <SkeletonText widths={[58]} />
        </span>
      </SkeletonPanel>
    </main>
  );
}

import {
  SkeletonAvatar,
  SkeletonButton,
  SkeletonField,
  SkeletonPanel,
  SkeletonStatus,
  SkeletonText,
} from '@knoqra/ui';
import type { ReactNode } from 'react';

/**
 * Today's loading outlines. Only the loading states change; the page itself is M5's design.
 *
 * M5 owns Today, so its layout classes are copied here rather than shared (the other pages share
 * theirs through @knoqra/ui and lib/contacts-layout). The sources, to keep in step by hand:
 * - COLUMNS and the 7-column day grid: components/today/week-grid.tsx:29-30 (COLUMNS, DAYS)
 * - the week grid panel: components/today/week-grid.tsx:253 (the WeekGrid <section> className)
 * - WidgetFrameSkeleton: components/today/widget-frame.tsx:125 (the <section> className)
 * - the header row: routes/_app/index.tsx:74 (the <header> className)
 * - the widgets grid: routes/_app/index.tsx:204-205 (the @container grid)
 * e2e/skeletons.spec.ts checks the header, week grid and first widget land where the outline drew
 * them (the anchor check), so a drift fails there.
 */

/** The greeting line under the date: one display line, as tall as the h1 it stands in for. */
export function GreetingSkeleton({ label }: { label?: string }) {
  return (
    <span className="flex min-w-[min(70vw,22rem)] flex-col">
      {label ? <SkeletonStatus label={label} /> : null}
      <SkeletonText widths={['100%']} lineHeight="clamp(30px, 3.6vw, 44px)" />
    </span>
  );
}

const COLUMNS =
  'grid grid-cols-[168px_minmax(0,1fr)] gap-x-3 xl:grid-cols-[206px_minmax(0,1fr)] items-center';
const WEEKDAYS = [true, true, true, true, true, false, false] as const;

/** People rows of the week grid: a 38px person chip, then seven 38px day cells. */
export function WeekRowsSkeleton({ label, rows = 1 }: { label?: string; rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {label ? <SkeletonStatus label={label} /> : null}
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder rows
        <span key={i} aria-hidden="true" className={COLUMNS}>
          <span className="flex h-[38px] min-w-0 items-center gap-[10px] rounded-[14px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-[10px]">
            <SkeletonAvatar size={28} seed={i} />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <SkeletonText widths={[`${70 - i * 12}%`]} lineHeight={13} seed={i} />
              <SkeletonText widths={[`${48 + i * 10}%`]} lineHeight={12} seed={i + 3} />
            </span>
          </span>
          <span className="grid grid-cols-7 gap-2">
            {WEEKDAYS.map((working, day) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the seven days of the week
                key={day}
                className={`h-[38px] rounded-[12px] ${
                  working
                    ? 'bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]'
                    : 'bg-[image:var(--hatch)]'
                }`}
              />
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The week grid panel: title, the week stepper, the day headers and the people rows. */
function WeekGridOutline() {
  return (
    <SkeletonPanel
      data-skeleton-part="week-grid"
      className="flex min-w-0 flex-col gap-3 rounded-[30px] px-4 py-4 sm:px-[22px]"
    >
      <span className="flex flex-wrap items-center gap-x-[10px] gap-y-2">
        <SkeletonText widths={['19rem']} lineHeight="clamp(22px, 2.4vw, 30px)" />
        {/* Shown at every width, as the real one: on a phone it wraps to its own line. */}
        <span className="sm:ml-2">
          <SkeletonText size="mono" widths={['16rem']} lineHeight={12} />
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-[6px]">
          <SkeletonButton size="icon" height={38} />
          <SkeletonButton width={150} height={38} />
          <SkeletonButton size="icon" height={38} />
        </span>
      </span>
      <span className="-mx-1 block overflow-hidden px-1 pb-1">
        <span className="flex min-w-[740px] flex-col gap-2">
          <span className={COLUMNS}>
            <SkeletonText widths={['4rem']} className="pl-1" />
            <span className="grid grid-cols-7 gap-2">
              {WEEKDAYS.map((_, day) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: the seven days of the week
                  key={day}
                  className="flex h-10 flex-col justify-center gap-[3px] rounded-[13px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)]"
                >
                  <SkeletonText size="mono" widths={['1.6rem']} align="center" className="w-full" />
                  <SkeletonText
                    size="mono"
                    widths={['0.9rem']}
                    lineHeight={14}
                    align="center"
                    className="w-full"
                  />
                </span>
              ))}
            </span>
          </span>
          <WeekRowsSkeleton />
        </span>
      </span>
    </SkeletonPanel>
  );
}

type Tone = 'light' | 'dark';

const frameTones: Record<Tone, string> = {
  light:
    'border-[color:var(--panelBorder)] bg-[image:var(--panel)] [box-shadow:var(--panelShadow)]',
  dark: 'border-[color:var(--panelBorder)] bg-[image:var(--streak-panel)] [box-shadow:var(--streak-shadow)] [--muted:var(--streak-muted)]',
};

/** A widget frame (WidgetFrame) holding a loading body: header title and its right-hand pill. */
function WidgetFrameSkeleton({
  tone = 'light',
  title,
  aside,
  children,
}: {
  tone?: Tone;
  title: string;
  aside: number;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      data-skeleton-part="widget"
      className={`flex min-w-0 flex-col gap-[14px] rounded-[30px] border px-5 py-[18px] ${frameTones[tone]}`}
    >
      <span className="flex min-h-[30px] items-center gap-2">
        <SkeletonText widths={[title]} lineHeight={18} />
        <span className="flex-1" />
        <SkeletonButton width={aside} height={26} />
      </span>
      {children}
    </span>
  );
}

/** The streak body: the big number with its two lines, the 16-week heatmap and the footnote. */
export function StreakBodySkeleton({ label }: { label?: string }) {
  return (
    <span className="flex flex-1 flex-col gap-[14px] [--muted:var(--streak-muted)]">
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex items-end gap-3">
        <SkeletonButton width={44} height={56} className="[--ars-radius:10px]" />
        <span className="flex min-w-0 flex-1 flex-col gap-[5px] pb-[2px]">
          <SkeletonText widths={['70%']} lineHeight={16.5} />
          <SkeletonText widths={['90%']} lineHeight={17.55} />
        </span>
      </span>
      <span aria-hidden="true" className="flex w-full max-w-[340px] flex-col gap-[6px]">
        <span className="grid grid-cols-[18px_minmax(0,1fr)] gap-[4px]">
          <span />
          <SkeletonText size="mono" widths={['100%']} lineHeight={16.5} />
          <span />
          <span className="aspect-[16/7] w-full rounded-[6px] bg-[color:var(--heat-0)] opacity-70" />
        </span>
        <SkeletonText size="mono" widths={['100%']} lineHeight={16.5} className="mt-[2px]" />
      </span>
      <SkeletonText size="mono" widths={['85%']} lineHeight={16.5} className="mt-auto" />
    </span>
  );
}

/** The focus body: the 136px goal ring beside its three legend lines, then the activity bar. */
export function FocusBodySkeleton({ label }: { label?: string }) {
  return (
    <span className="flex flex-col gap-[14px]">
      {label ? <SkeletonStatus label={label} /> : null}
      <span aria-hidden="true" className="flex items-center gap-[18px]">
        <SkeletonAvatar size={136} />
        <span className="flex min-w-0 flex-1 flex-col gap-[10px]">
          <SkeletonText widths={['80%']} lineHeight={16.25} />
          <SkeletonText widths={['70%']} lineHeight={16.25} />
          <SkeletonText widths={['56%']} lineHeight={16.25} />
        </span>
      </span>
      <span aria-hidden="true" className="flex flex-col gap-2">
        <SkeletonText size="mono" widths={['100%']} lineHeight={13} />
        <span className="h-[10px] rounded-[5px] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]" />
        <SkeletonText size="mono" widths={['72%']} lineHeight={11} />
      </span>
    </span>
  );
}

/** Up Next: two task cards, as UpNextCard draws them. */
export function UpNextBodySkeleton({ label }: { label?: string }) {
  return (
    <span className="flex flex-1 flex-col gap-[10px]">
      {label ? <SkeletonStatus label={label} /> : null}
      {[0, 1].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="flex flex-col gap-[10px] rounded-[20px] border border-[color:var(--pillBorder)] p-[14px]"
        >
          <span className="flex items-start justify-between gap-2">
            <SkeletonText
              widths={[`${72 - i * 16}%`]}
              lineHeight={18}
              className="flex-1"
              seed={i}
            />
            <SkeletonButton width={64} height={21} />
          </span>
          <span className="flex items-center gap-[6px]">
            <SkeletonButton width={96} height={32} className="[--ars-radius:10px]" />
            <span className="flex-1" />
            <SkeletonButton width={64} height={32} />
          </span>
        </span>
      ))}
    </span>
  );
}

/** Otto's answer card while it drafts: eyebrow, three lines of text, the two small buttons. */
export function OttoResultSkeleton({ label }: { label?: string }) {
  return (
    <span className="flex flex-col gap-2 rounded-[16px] bg-[color:var(--cell)] px-[14px] py-3">
      {label ? <SkeletonStatus label={label} /> : null}
      <SkeletonText size="mono" widths={['40%']} />
      <SkeletonText lines={3} widths={[96, 88, 54]} lineHeight={18.85} />
      <span aria-hidden="true" className="flex gap-[6px]">
        <SkeletonButton width={64} height={30} />
        <SkeletonButton width={72} height={30} />
      </span>
    </span>
  );
}

/** Otto before anyone asks: head, prompt line, contact picker, the three action pills. */
function OttoBodySkeleton() {
  return (
    <>
      <span aria-hidden="true" className="-mt-1 flex flex-col items-center gap-3">
        <SkeletonAvatar size={116} />
        <SkeletonText widths={['80%']} lineHeight={26.25} align="center" className="w-full" />
      </span>
      <SkeletonField />
      <span aria-hidden="true" className="flex flex-wrap justify-center gap-[6px]">
        <SkeletonButton width={104} height={34} />
        <SkeletonButton width={96} height={34} />
        <SkeletonButton width={128} height={34} />
      </span>
    </>
  );
}

/** The four widgets in Today's grid (same container query columns), for while the layout loads. */
export function WidgetsSkeleton({ label }: { label?: string }) {
  return (
    <div className="@container">
      {label ? <SkeletonStatus label={label} /> : null}
      <div className="grid @min-[1240px]:grid-cols-4 @min-[640px]:grid-cols-2 grid-cols-1 gap-4">
        <WidgetFrameSkeleton tone="dark" title="7.5rem" aside={84}>
          <StreakBodySkeleton />
        </WidgetFrameSkeleton>
        <WidgetFrameSkeleton title="5.5rem" aside={84}>
          <UpNextBodySkeleton />
        </WidgetFrameSkeleton>
        <WidgetFrameSkeleton title="6rem" aside={88}>
          <FocusBodySkeleton />
          <SkeletonButton width="100%" height={44} className="mt-auto" />
        </WidgetFrameSkeleton>
        <WidgetFrameSkeleton title="3rem" aside={210}>
          <OttoBodySkeleton />
        </WidgetFrameSkeleton>
      </div>
    </div>
  );
}

/** The Workspace ribbon: title, a two-line note and the three getting-started steps. */
export function WorkspaceRibbonSkeleton() {
  return (
    <SkeletonPanel className="flex flex-1 flex-col gap-4 p-[18px]">
      <SkeletonText widths={['6rem']} lineHeight={18} />
      <SkeletonText lines={2} widths={[96, 74]} lineHeight={18.125} />
      <span className="flex flex-col gap-2">
        {[62, 48, 70].map((w, i) => (
          <span
            key={w}
            className={`flex h-[45px] items-center gap-3 rounded-[16px] px-3 ${
              i === 2
                ? 'border-[1.5px] border-[color:var(--muted)] border-dashed'
                : 'bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]'
            }`}
          >
            <span className="size-4 shrink-0 rounded-[4px] border border-[color:var(--muted)] opacity-40" />
            <SkeletonText widths={[`${w}%`]} className="flex-1" />
          </span>
        ))}
      </span>
    </SkeletonPanel>
  );
}

/** Today while it loads: the header, the week grid and the widgets. The ribbon goes in the shell. */
export function TodaySkeleton() {
  return (
    <div data-skeleton="today" className="flex min-w-0 flex-col gap-4">
      <SkeletonStatus label="Loading your day" />
      <span
        aria-hidden="true"
        data-skeleton-part="today-header"
        className="flex flex-wrap items-end gap-x-4 gap-y-3 px-2 pt-1"
      >
        <span className="flex min-w-0 flex-col gap-[10px]">
          <SkeletonText size="mono" widths={['12rem']} lineHeight={12} />
          <GreetingSkeleton />
        </span>
        <span className="flex-1" />
        <span className="hidden sm:block">
          <SkeletonButton width={118} height={42} />
        </span>
        <SkeletonButton width={120} height={42} />
      </span>
      <WeekGridOutline />
      <WidgetsSkeleton />
    </div>
  );
}

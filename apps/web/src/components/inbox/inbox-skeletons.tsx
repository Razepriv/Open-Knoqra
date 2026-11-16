import { Panel, Skeleton } from '@knoqra/ui';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Full-shape loading placeholders for the Inbox: the same containers, paddings, radii and widths
 * as the real UI, so nothing moves when data arrives. Each region announces one status; the
 * pieces inside are decorative (aria-hidden).
 */

interface RegionProps {
  label: string;
  className?: string;
  children: ReactNode;
}

/** One accessible status for a whole region of placeholder shapes. */
function Region({ label, className, children }: RegionProps) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="contents">
        {children}
      </div>
    </div>
  );
}

interface ShapeProps {
  width?: number | string;
  height: number;
  circle?: boolean;
  /** Corner radius in px for a rounded block; circles use the full radius. */
  radius?: number;
  className?: string;
}

/** A glyph-pattern block with a rounded outline. */
function Shape({ width = '100%', height, circle, radius, className }: ShapeProps) {
  const style: CSSProperties = {
    width,
    height,
    borderRadius: circle ? '9999px' : (radius ?? 6),
  };
  return (
    <span className={`block shrink-0 overflow-hidden ${className ?? ''}`} style={style}>
      <Skeleton width="100%" height={height} circle={circle} />
    </span>
  );
}

const pillClass = 'rounded-[20px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)]';

/** A thread row: avatar, name and company, time stub, two preview lines, channel and state chips. */
export function ThreadRowSkeleton() {
  return (
    <li className={`flex flex-col gap-[9px] p-3 ${pillClass}`}>
      <span className="flex w-full items-center gap-[10px]">
        <Shape width={36} height={36} circle />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Shape width="55%" height={14} />
          <Shape width="35%" height={12} />
        </span>
        <Shape width={34} height={11} />
      </span>
      <span className="flex flex-col gap-1">
        <Shape width="92%" height={13} />
        <Shape width="60%" height={13} />
      </span>
      <span className="flex items-center gap-[6px]">
        <Shape width={56} height={26} radius={13} />
        <Shape width={84} height={26} radius={13} />
      </span>
    </li>
  );
}

const ROW_KEYS = ['a', 'b', 'c', 'd', 'e'] as const;

/** The conversation rows of the thread list while it loads. */
export function ThreadRowsSkeleton({ label = 'Loading conversations' }: { label?: string }) {
  return (
    <Region label={label}>
      <ul className="flex flex-col gap-2 p-1">
        {ROW_KEYS.map((key) => (
          <ThreadRowSkeleton key={key} />
        ))}
      </ul>
    </Region>
  );
}

/** Title, Templates icon and New message pill. */
function ListHeaderSkeleton() {
  return (
    <div className="flex items-center gap-2 px-2" aria-hidden="true">
      <Shape width={92} height={30} />
      <span className="flex-1" />
      <Shape width={36} height={36} circle />
      <Shape width={128} height={36} radius={18} />
    </div>
  );
}

/** Filter pills and the search box. */
function ListControlsSkeleton() {
  return (
    <>
      <div className="flex flex-wrap gap-[6px] px-[6px]" aria-hidden="true">
        {[44, 70, 48, 86].map((width) => (
          <Shape key={width} width={width} height={34} radius={17} />
        ))}
      </div>
      <div className="mx-1" aria-hidden="true">
        <Shape height={44} radius={22} />
      </div>
    </>
  );
}

const BUBBLES: ReadonlyArray<{ side: 'left' | 'right'; width: string; note?: boolean }> = [
  { side: 'left', width: '46%' },
  { side: 'right', width: '58%' },
  { side: 'left', width: '38%' },
  { side: 'right', width: '52%', note: true },
  { side: 'right', width: '34%' },
];

/** A day label and alternating message bubbles (radius 20) with one dashed note bubble. */
function BubblesSkeleton() {
  return (
    <>
      <span className="flex items-center self-center">
        <Shape width={72} height={26} radius={13} />
      </span>
      <ol className="flex flex-col gap-[10px]">
        {BUBBLES.map(({ side, width, note }) => (
          <li
            key={`${side}-${width}`}
            className={`flex ${side === 'left' ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`flex flex-col gap-[6px] px-[14px] py-[11px] ${
                note
                  ? 'rounded-[20px] border-[1.5px] border-[color:var(--muted)] border-dashed bg-[color:var(--cell)]'
                  : pillClass
              }`}
              style={{ width }}
            >
              <Shape height={14} />
              <Shape width="70%" height={14} />
              <Shape width={64} height={10} />
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

/** The messages area only (inside an already-rendered thread panel). */
export function ThreadMessagesSkeleton() {
  return (
    <Region label="Loading messages" className="flex flex-col gap-[10px]">
      <BubblesSkeleton />
    </Region>
  );
}

function ThreadHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3 px-[18px] pt-4 pb-3">
      <Shape width={44} height={44} circle />
      <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <Shape width="42%" height={20} />
        <div className="flex items-center gap-2">
          <Shape width={72} height={24} radius={12} />
          <Shape width={96} height={11} />
        </div>
      </div>
    </div>
  );
}

function ComposerSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-[14px] pb-[14px]">
      <div className="flex gap-[6px] px-1">
        <Shape width={64} height={32} radius={16} />
        <Shape width={52} height={32} radius={16} />
      </div>
      <div className="flex items-end gap-2 rounded-[22px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] p-2">
        <span className="min-w-0 flex-1">
          <Shape height={44} radius={14} />
        </span>
        <Shape width={44} height={44} circle />
      </div>
    </div>
  );
}

/** The open conversation while it loads: header, day label, bubbles and composer outline. */
export function ThreadViewSkeleton() {
  return (
    <Panel className="flex min-h-[560px] min-w-0 flex-col overflow-hidden lg:max-h-[calc(100dvh_-_2_*_var(--page-pad,0px)_-_6rem)]">
      <Region label="Loading conversation" className="flex min-h-0 flex-1 flex-col">
        <ThreadHeaderSkeleton />
        <div className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-hidden px-[18px] py-4">
          <BubblesSkeleton />
        </div>
        <ComposerSkeleton />
      </Region>
    </Panel>
  );
}

const CONSENT_KEYS = ['sms', 'whatsapp'] as const;

/** The context ribbon while it loads: contact card, window banner, sender and consent rows. */
export function RibbonSkeleton({ whatsapp = true }: { whatsapp?: boolean }) {
  return (
    <Panel className="flex flex-1 flex-col gap-3 overflow-auto p-[18px]">
      <Region label="Loading contact" className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2 pt-1 pb-[6px]">
          <Shape width={72} height={72} circle />
          <Shape width={140} height={21} />
          <Shape width={90} height={13} />
          <Shape width={124} height={28} radius={14} />
        </div>
        {whatsapp ? (
          <div className="flex flex-col gap-2 rounded-[16px] bg-[color:var(--cell)] px-[14px] py-[10px]">
            <Shape width="70%" height={15} />
            <Shape height={8} radius={4} />
            <Shape width={80} height={11} />
          </div>
        ) : null}
        <Shape width={96} height={11} />
        <div className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]">
          <Shape width="60%" height={13} />
          <Shape width="85%" height={12} />
        </div>
        <Shape width={150} height={11} />
        <ul className="flex flex-col gap-[6px]">
          {CONSENT_KEYS.map((key) => (
            <li
              key={key}
              className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]"
            >
              <Shape width="45%" height={13} />
              <Shape width="90%" height={12} />
            </li>
          ))}
        </ul>
      </Region>
    </Panel>
  );
}

const TEMPLATE_KEYS = ['a', 'b', 'c'] as const;

/** Template rows (name, approval chip, body lines) for the dialog and the picker. */
export function TemplateRowsSkeleton({ label = 'Loading templates' }: { label?: string }) {
  return (
    <Region label={label} className="flex flex-col gap-[6px]">
      {TEMPLATE_KEYS.map((key) => (
        <div
          key={key}
          className="flex flex-col gap-1 rounded-[14px] bg-[color:var(--cell)] px-3 py-[10px]"
        >
          <div className="flex items-center gap-2">
            <Shape width="40%" height={13} />
            <span className="flex-1" />
            <Shape width={64} height={12} radius={6} />
          </div>
          <Shape width="92%" height={12} />
          <Shape width="58%" height={12} />
        </div>
      ))}
    </Region>
  );
}

/** The whole Inbox: list panel (header, filters, search, rows) beside the middle pane. */
export function InboxPageSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[330px_minmax(0,1fr)]">
      <Panel className="flex min-h-0 flex-col gap-3 overflow-hidden px-3 pt-[18px] pb-3">
        <ListHeaderSkeleton />
        <ListControlsSkeleton />
        <div className="min-h-0 flex-1 overflow-auto">
          <ThreadRowsSkeleton />
        </div>
      </Panel>
      <ThreadViewSkeleton />
    </div>
  );
}

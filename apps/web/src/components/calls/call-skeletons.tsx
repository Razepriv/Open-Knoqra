import { Panel, Skeleton } from '@knoqra/ui';
import type { CSSProperties, ReactNode } from 'react';
import { PageRibbon } from '../shell/ribbon';

// Loading states for the Calls page, shaped like what replaces them so nothing shifts when data
// arrives. Each one is a single status for assistive tech; the glyph pieces inside are hidden.

const pill =
  'rounded-[18px] border border-[color:var(--pillBorder)] bg-[color:var(--pill)] [box-shadow:var(--pillShadow)]';

/** One announced status around a composition of skeleton pieces. */
export function SkeletonGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-label={label} className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="contents">
        {children}
      </div>
    </div>
  );
}

/** A still block of a given size (an avatar, a chip, a button). */
export function SkeletonBlock({
  width,
  height,
  circle = false,
  className,
}: {
  width: number | string;
  height: number;
  circle?: boolean;
  className?: string;
}) {
  return (
    <Skeleton
      rows={Math.max(1, Math.round(height / 12))}
      width={width}
      height={height}
      circle={circle}
      animate={false}
      label=""
      className={`shrink-0 ${className ?? ''}`}
    />
  );
}

/** Text lines; widths are percentages of the slot. */
export function SkeletonLines({ widths, className }: { widths: number[]; className?: string }) {
  return (
    <Skeleton
      lines={widths.length}
      widths={widths}
      animate={false}
      label=""
      className={className}
    />
  );
}

const RECENT_WIDTHS = [
  [62, 80],
  [48, 70],
  [70, 66],
  [55, 74],
  [66, 60],
];

/** Recents rows: avatar, name and number lines, a state chip, and the call back button. */
export function RecentsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <SkeletonGroup label="Loading recent calls" className="flex flex-col gap-2 p-[2px]">
      {RECENT_WIDTHS.slice(0, rows).map(([name, number], index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of placeholders
          key={index}
          className={`grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-[10px] ${pill}`}
        >
          <SkeletonBlock width={36} height={36} circle />
          <div className="flex min-w-0 flex-col gap-[7px]">
            <SkeletonLines widths={[name ?? 60, number ?? 70]} />
            <SkeletonBlock width={96} height={24} className="rounded-[12px]" />
          </div>
          <SkeletonBlock width={38} height={38} circle />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Voicemail cards: caller line, playback note, transcript cell, Call back and Mark listened. */
export function VoicemailSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <SkeletonGroup label="Loading voicemail" className="flex flex-col gap-2 p-[2px]">
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of placeholders
        <div key={index} className={`flex flex-col gap-3 p-4 ${pill}`}>
          <div className="flex items-center gap-[10px]">
            <SkeletonBlock width={36} height={36} circle />
            <SkeletonLines widths={[55, 70]} className="min-w-0 flex-1" />
          </div>
          <SkeletonLines widths={[48]} />
          <div className="rounded-[14px] bg-[color:var(--cell)] p-3">
            <SkeletonLines widths={[40, 92, 64]} />
          </div>
          <div className="flex gap-2">
            <SkeletonBlock width={112} height={40} className="rounded-[20px]" />
            <SkeletonBlock width={124} height={40} className="rounded-[20px]" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

const cell = 'flex flex-col gap-[8px] rounded-[18px] bg-[color:var(--cell)] px-[14px] py-3';

/** The wallet ribbon: heading and dot, three figures, the cap bar and its labels, two actions. */
export function WalletSkeleton() {
  return (
    <SkeletonGroup label="Loading your wallet" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SkeletonLines widths={[46, 30]} className="flex-1" />
        <SkeletonBlock width={10} height={10} circle />
      </div>
      <div className="grid gap-2">
        <div className={cell}>
          <SkeletonLines widths={[30]} />
          <SkeletonBlock width="55%" height={30} />
          <SkeletonLines widths={[50]} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[0, 1].map((key) => (
            <div key={key} className={cell}>
              <SkeletonLines widths={[60]} />
              <SkeletonBlock width="70%" height={20} />
              <SkeletonLines widths={[80]} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <SkeletonBlock width="100%" height={14} className="mt-1 rounded-[7px]" />
        <div className="flex justify-between">
          <SkeletonBlock width={78} height={11} />
          <SkeletonBlock width={78} height={11} />
        </div>
        <SkeletonLines widths={[60]} />
      </div>
      <div className="flex gap-2">
        <SkeletonBlock width={104} height={34} className="rounded-[17px]" />
        <SkeletonBlock width={110} height={34} className="rounded-[17px]" />
      </div>
    </SkeletonGroup>
  );
}

/** The dialer panel: heading and live-updates pill, the number field, the 4x3 keypad, Call. */
export function DialerSkeleton() {
  return (
    <Panel className="flex min-h-0 flex-col p-[18px]">
      <SkeletonGroup label="Loading the dialer" className="flex min-h-0 flex-col gap-[14px]">
        <div className="flex items-center gap-[10px]">
          <SkeletonLines widths={[30, 45]} className="flex-1" />
          <SkeletonBlock width={112} height={30} className="rounded-[15px]" />
        </div>
        <div className="flex flex-col gap-[10px] rounded-[22px] bg-[color:var(--cell)] px-4 py-[14px] [box-shadow:var(--cellShadow)]">
          <div className="flex items-center gap-2">
            <SkeletonBlock width="70%" height={40} />
            <span className="flex-1" />
            <SkeletonBlock width={40} height={40} circle />
          </div>
          <SkeletonLines widths={[45]} />
        </div>
        <div className="grid grid-cols-3 gap-[10px]">
          {Array.from({ length: 12 }, (_, key) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: twelve fixed keys
            <SkeletonBlock key={key} width="100%" height={58} className="rounded-[20px]" />
          ))}
        </div>
        <SkeletonBlock width="100%" height={56} className="rounded-[28px]" />
      </SkeletonGroup>
    </Panel>
  );
}

/** The pre-call check while it runs: the two chips an allowed call shows (consent, hold). */
export function DialCheckSkeleton() {
  return (
    <SkeletonGroup label="Checking this number" className="flex flex-wrap justify-center gap-[6px]">
      <SkeletonBlock width={128} height={28} className="rounded-[14px]" />
      <SkeletonBlock width={208} height={28} className="rounded-[14px]" />
    </SkeletonGroup>
  );
}

/** A dark live surface in both themes, as the live call panel draws it. */
const liveSkeletonSurface: CSSProperties = {
  background:
    'radial-gradient(120% 80% at 100% 0%, color-mix(in srgb, var(--accent) 16%, var(--shell)) 0%, var(--shell) 55%)',
};

/** The live call panel: direction pill, avatar, name, number, timer, state line, three controls. */
export function LiveCallSkeleton() {
  return (
    <div
      data-theme="dark"
      style={liveSkeletonSurface}
      className="flex min-h-0 flex-1 flex-col rounded-[30px] border border-[color:var(--panelBorder)] p-[22px] text-[color:var(--text)] [box-shadow:var(--panelShadow)]"
    >
      <SkeletonGroup
        label="Loading your call"
        className="flex flex-col items-center gap-[10px] text-center"
      >
        <SkeletonBlock width={128} height={30} className="rounded-[15px]" />
        <SkeletonBlock width={84} height={84} circle className="mt-[6px]" />
        <SkeletonBlock width={190} height={27} />
        <SkeletonBlock width={128} height={12} />
        <SkeletonBlock width={150} height={60} className="mt-[6px] mb-[2px]" />
        <SkeletonBlock width={96} height={16} />
        <div className="mt-1 flex justify-center gap-[14px]">
          {[0, 1, 2].map((key) => (
            <SkeletonBlock key={key} width={62} height={62} circle />
          ))}
        </div>
      </SkeletonGroup>
    </div>
  );
}

/** The call dock: avatar, name and state lines, Mute, Open and Hang up. */
export function CallDockSkeleton() {
  return (
    <>
      <div aria-hidden="true" className="h-[88px] shrink-0" />
      <div className="fixed bottom-24 left-1/2 z-40 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-[26px] border border-[color:var(--panelBorder)] bg-[color:var(--shell)] py-2 pr-2 pl-3 text-[color:var(--text)] [box-shadow:var(--panelShadow)] lg:bottom-10">
        <SkeletonGroup label="Loading your call" className="flex items-center gap-3">
          <SkeletonBlock width={36} height={36} circle />
          <SkeletonLines widths={[40, 62]} className="min-w-0 flex-1" />
          <SkeletonBlock width={82} height={34} className="rounded-[17px]" />
          <SkeletonBlock width={74} height={34} className="rounded-[17px]" />
          <SkeletonBlock width={104} height={34} className="rounded-[17px]" />
        </SkeletonGroup>
      </div>
    </>
  );
}

/** The whole Calls page while its route loads: dialer, the Calls panel and the Wallet ribbon. */
export function CallsPageSkeleton() {
  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(320px,430px)_minmax(0,1fr)]">
      <DialerSkeleton />
      <Panel className="flex min-h-0 flex-col gap-3 p-[18px]">
        <SkeletonGroup label="Loading calls" className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <SkeletonBlock width={90} height={30} />
            <span className="flex-1" />
            <SkeletonBlock width={86} height={36} className="rounded-[18px]" />
            <SkeletonBlock width={96} height={36} className="rounded-[18px]" />
          </div>
          <RecentsSkeleton />
        </SkeletonGroup>
      </Panel>
      <PageRibbon label="Wallet">
        <WalletRibbonSkeleton />
      </PageRibbon>
    </div>
  );
}

/** The Wallet ribbon's panel while it loads; the shell outline draws it in the ribbon column. */
export function WalletRibbonSkeleton() {
  return (
    <Panel className="flex flex-1 flex-col gap-4 overflow-auto p-[18px]">
      <WalletSkeleton />
    </Panel>
  );
}

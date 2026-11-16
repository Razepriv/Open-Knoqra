import { Button, Panel, Reveal } from '@knoqra/ui';
import { CircleGauge, Plus, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { deskSlot } from '../../extensions';
import { useMe } from '../../lib/api';
import { formatMicros } from '../../lib/money';
import { textPill } from '../../lib/ui-classes';
import { useWallet, type WalletSummary } from '../../lib/wallet';
import { capMarks, isOwnerOrAdmin, walletNotice, walletTone } from '../../lib/wallet-form';
import { WalletSkeleton } from './call-skeletons';
import { CapsDialog, CreditDialog } from './caps-dialog';

const eyebrow =
  'font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] uppercase leading-[1.3] tracking-[.04em]';

const TONE_LABEL = { ok: 'Spending normally', warn: 'Near the WARN cap', bad: 'Calls paused' };
const FILL = { ok: 'var(--accent)', warn: 'var(--dot-warn)', bad: 'var(--dot-bad)' };

type Open = 'caps' | 'credit' | null;

/**
 * The Calls page ribbon: what the workspace can spend on calls (Available, Held, Spent this
 * month), where this month's spend sits against the WARN and STOP caps, and, for owners and
 * admins, Edit caps and Add credit (an edition may add its own funding buttons: extensions.ts).
 * Kept fresh by `wallet.updated` over realtime.
 */
export function WalletPanel() {
  const wallet = useWallet();
  const me = useMe();
  const [open, setOpen] = useState<Open>(null);
  const manager = isOwnerOrAdmin(me.data?.organization.role);
  return (
    <Panel className="flex flex-1 flex-col gap-4 overflow-auto p-[18px]">
      <Reveal loading={wallet.isPending}>
        {wallet.isPending ? (
          <WalletSkeleton />
        ) : wallet.data ? (
          // A failed background refetch keeps the figures already on screen.
          <WalletBody
            summary={wallet.data}
            manager={manager}
            onEditCaps={() => setOpen('caps')}
            onAddCredit={() => setOpen('credit')}
          />
        ) : (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-[14px] text-[color:var(--muted)]">We could not load the wallet.</p>
            <Button variant="ghost" onClick={() => void wallet.refetch()}>
              Try again
            </Button>
          </div>
        )}
      </Reveal>
      {wallet.data && open === 'caps' ? (
        <CapsDialog summary={wallet.data} onClose={() => setOpen(null)} />
      ) : null}
      {open === 'credit' ? <CreditDialog onClose={() => setOpen(null)} /> : null}
    </Panel>
  );
}

interface WalletBodyProps {
  summary: WalletSummary;
  manager: boolean;
  onEditCaps: () => void;
  onAddCredit: () => void;
}

function WalletBody({ summary, manager, onEditCaps, onAddCredit }: WalletBodyProps) {
  const WalletFunding = deskSlot('WalletFunding');
  const addCredit = (
    <Button variant="primary" className="h-[34px] px-3 text-[13px]" onClick={onAddCredit}>
      <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
      Add credit
    </Button>
  );
  // The paused and low-balance states follow the next call's hold, as the dialer does (R24).
  const tone = walletTone(summary.dialStatus);
  const notice = walletNotice(summary.dialStatus);
  return (
    <section aria-labelledby="wallet-heading" className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-[5px]">
          <span className={eyebrow}>App ledger · USD</span>
          <h2
            id="wallet-heading"
            className="font-[family-name:var(--font-display)] text-[22px] leading-none tracking-[-0.02em]"
          >
            Wallet
          </h2>
        </div>
        <span className="flex-1" />
        <span
          role="img"
          aria-label={TONE_LABEL[tone]}
          title={TONE_LABEL[tone]}
          className="size-[10px] rounded-full"
          style={{ background: `var(--dot-${tone})` }}
        />
      </div>
      <div className="grid gap-2">
        <Stat label="Available" micros={summary.availableMicros} note="Ready for new calls" />
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Held"
            micros={summary.heldMicros}
            note={summary.heldMicros > 0 ? 'For calls in progress' : 'Nothing held'}
            small
          />
          <Stat
            label="Spent this month"
            micros={summary.periodSpendMicros}
            note="Calendar month, UTC"
            small
          />
        </div>
      </div>
      <CapBar summary={summary} tone={tone} />
      {notice ? (
        <p
          role={tone === 'bad' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-[16px] px-3 py-2 text-[13px] leading-snug ${
            tone === 'bad'
              ? 'border border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]'
              : 'bg-[color:var(--cell)]'
          }`}
        >
          <CircleGauge size={15} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
          {notice}
        </p>
      ) : null}
      {manager ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={textPill} onClick={onEditCaps}>
            <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
            Edit caps
          </button>
          {WalletFunding ? (
            <WalletFunding addCredit={addCredit} onAddCredit={onAddCredit} />
          ) : (
            addCredit
          )}
        </div>
      ) : (
        <p className="text-[12.5px] text-[color:var(--muted)] leading-snug">
          Owners and admins set the caps and add credit.
        </p>
      )}
    </section>
  );
}

function Stat({
  label,
  micros,
  note,
  small = false,
}: {
  label: string;
  micros: number;
  note: string;
  small?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls, not a figure
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 flex-col gap-[6px] rounded-[18px] bg-[color:var(--cell)] px-[14px] py-3"
    >
      <span className="font-medium text-[12px] text-[color:var(--muted)] leading-none">
        {label}
      </span>
      <span
        className={`font-[family-name:var(--font-display)] font-medium leading-none tracking-[-0.02em] [font-variant-numeric:tabular-nums] ${
          small ? 'text-[20px]' : 'text-[30px]'
        }`}
      >
        {formatMicros(micros)}
      </span>
      <span className="text-[11.5px] text-[color:var(--muted)] leading-[1.3]">{note}</span>
    </div>
  );
}

function CapBar({ summary, tone }: { summary: WalletSummary; tone: 'ok' | 'warn' | 'bad' }) {
  const marks = capMarks(summary);
  const warn = summary.warnCapMicros;
  const stop = summary.stopCapMicros;
  if (!marks) {
    return (
      <p className="text-[12.5px] text-[color:var(--muted)] leading-snug">
        No spend caps set. Calls stop only when the balance runs out.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot hold the WARN and STOP markers */}
      <div
        role="meter"
        aria-label="Spent this month against the caps"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(marks.usedPct)}
        aria-valuetext={`${formatMicros(summary.periodSpendMicros)} spent`}
        className="relative mt-1 h-[14px] rounded-[7px] bg-[color:var(--cell)] [box-shadow:var(--cellShadow)]"
      >
        <div
          className="h-[14px] rounded-[7px] transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${marks.usedPct}%`, background: FILL[tone] }}
        />
        {marks.warnPct === null ? null : <Marker pct={marks.warnPct} color="var(--dot-warn)" />}
        {marks.stopPct === null ? null : <Marker pct={marks.stopPct} color="var(--dot-bad)" />}
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 font-[family-name:var(--font-mono)] font-medium text-[11px] text-[color:var(--muted)] leading-none">
        <span>{warn === null ? 'WARN off' : `WARN ${formatMicros(warn)}`}</span>
        <span>{stop === null ? 'STOP off' : `STOP ${formatMicros(stop)}`}</span>
      </div>
      <span className="text-[11.5px] text-[color:var(--muted)] leading-[1.3]">
        App policy, not a provider cap.
      </span>
    </div>
  );
}

function Marker({ pct, color }: { pct: number; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="absolute top-[-4px] h-[22px] w-[2px] -translate-x-1/2 rounded-[1px]"
      style={{ left: `${pct}%`, background: color }}
    />
  );
}

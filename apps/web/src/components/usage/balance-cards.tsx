import { Button, Panel, Reveal, StatusDot } from '@knoqra/ui';
import { CircleGauge, RefreshCw } from 'lucide-react';
import { useMe } from '../../lib/api';
import { formatMicros } from '../../lib/money';
import { useSetup } from '../../lib/setup';
import { textPill } from '../../lib/ui-classes';
import {
  type ProviderSnapshot,
  providerStatusCopy,
  relativeAgo,
  type SpendDecision,
  spendBannerCopy,
  type UsageBalance,
  useRefreshBalance,
  useUsageBalance,
} from '../../lib/usage';
import { useNow } from '../../lib/use-now';
import { BalanceCardsSkeleton } from './usage-layout';
import { BlockError, cellSurface, eyebrow, Slot, sectionHeading } from './usage-states';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const CONNECT_TELNYX_PATH = '/setup?step=connect';
const MINUTE_MS = 60_000;

const PROVIDER_DOT = { ok: 'ok', auth_failed: 'bad', unavailable: 'warn' } as const;

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${cellSurface} flex min-w-0 flex-col gap-2`}>
      <span className={eyebrow}>{label}</span>
      <span className="font-[family-name:var(--font-display)] text-[28px] leading-none tracking-[-0.02em]">
        {value}
      </span>
    </div>
  );
}

function WalletCard({ wallet }: { wallet: UsageBalance['wallet'] }) {
  return (
    <Panel aria-label="Wallet" className="flex flex-col gap-4 p-5 sm:p-6">
      <h2 className={sectionHeading}>Wallet</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure label="Available" value={formatMicros(wallet.availableMicros)} />
        <Figure label="Held" value={formatMicros(wallet.heldMicros)} />
        <Figure label="Spent this month" value={formatMicros(wallet.periodSpendMicros)} />
      </div>
    </Panel>
  );
}

function RefreshButton({
  refresh,
  className = '',
}: {
  refresh: ReturnType<typeof useRefreshBalance>;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      className={`${className} h-[34px] px-3 text-[13px]`}
      onClick={refresh.isPending ? undefined : () => refresh.mutate()}
      aria-busy={refresh.isPending}
    >
      <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
      {refresh.isPending ? 'Refreshing…' : 'Refresh'}
    </Button>
  );
}

/** No snapshot yet: connected (a saved key) shows "Not checked yet", otherwise a way to connect. */
function NoSnapshot({ canRefresh }: { canRefresh: boolean }) {
  const setup = useSetup();
  const refresh = useRefreshBalance();
  if (setup.isPending) {
    return (
      <div className={`${cellSurface} flex flex-col items-start gap-3`}>
        <Slot height={20} width={120} label="Loading Telnyx connection" />
        <Slot height={18} width="80%" />
        <Slot height={34} width={140} />
      </div>
    );
  }
  const credential = setup.data?.checks.find((check) => check.id === 'credential');
  const connected = credential !== undefined && credential.status !== 'fail';
  if (connected) {
    return (
      <div className={`${cellSurface} flex flex-col items-start gap-3`}>
        <StatusDot status="none" label="Not checked yet" />
        <p className="text-[13px] text-[color:var(--muted)] leading-snug">
          The Telnyx balance has not been read yet.
        </p>
        {canRefresh ? <RefreshButton refresh={refresh} /> : null}
        {refresh.isError ? (
          <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
            Could not refresh the Telnyx balance. Try again.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={`${cellSurface} flex flex-col items-start gap-3`}>
      <StatusDot status="none" label="Not connected" />
      <p className="text-[13px] text-[color:var(--muted)] leading-snug">
        Connect Telnyx to see your provider balance here.
      </p>
      <a href={CONNECT_TELNYX_PATH} className={textPill}>
        Connect Telnyx
      </a>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderSnapshot }) {
  const me = useMe();
  const refresh = useRefreshBalance();
  const now = useNow(MINUTE_MS);
  const canRefresh = me.data ? MANAGER_ROLES.has(me.data.organization.role) : false;
  return (
    <Panel aria-label="Telnyx balance" className="flex flex-col gap-4 p-5 sm:p-6">
      <h2 className={sectionHeading}>Telnyx balance</h2>
      {provider ? (
        <div className={`${cellSurface} flex flex-col gap-3`}>
          <span className={eyebrow}>Provider balance</span>
          <span className="font-[family-name:var(--font-display)] text-[28px] leading-none tracking-[-0.02em]">
            {provider.balanceMicros === null ? 'Unknown' : formatMicros(provider.balanceMicros)}
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <StatusDot
              status={PROVIDER_DOT[provider.status]}
              label={providerStatusCopy(provider.status)}
            />
            <span className="text-[13px] text-[color:var(--muted)]">
              {`As of ${relativeAgo(provider.capturedAt, now)}`}
            </span>
            {canRefresh ? <RefreshButton refresh={refresh} className="ml-auto" /> : null}
          </div>
          {refresh.isError ? (
            <p role="alert" className="text-[13px] text-[color:var(--danger-text)]">
              Could not refresh the Telnyx balance. Try again.
            </p>
          ) : null}
        </div>
      ) : (
        <NoSnapshot canRefresh={canRefresh} />
      )}
    </Panel>
  );
}

function SpendBanner({ spend }: { spend: SpendDecision }) {
  const message = spendBannerCopy(spend);
  if (message === null) return null;
  const stop = spend.outcome === 'stop';
  return (
    <p
      role={stop ? 'alert' : 'status'}
      className={`flex items-center gap-2 rounded-[16px] px-4 py-3 text-[14px] leading-snug ${
        stop
          ? 'border border-[color:var(--blocked-border)] [background:var(--blocked-stripe)]'
          : 'bg-[color:var(--cell)]'
      }`}
    >
      <CircleGauge size={16} strokeWidth={1.75} aria-hidden="true" />
      {message}
    </p>
  );
}

/** Row 1: the wallet, the provider's balance, and the banner when spending is limited. */
export function BalanceCards() {
  const balance = useUsageBalance();
  if (balance.isError && !balance.data) {
    return (
      <Panel className="p-5 sm:p-6">
        <BlockError
          what="your balances"
          error={balance.error}
          onRetry={() => void balance.refetch()}
          retrying={balance.isFetching}
        />
      </Panel>
    );
  }
  return (
    <Reveal loading={balance.isPending}>
      {balance.data ? (
        <div className="flex flex-col gap-3">
          <SpendBanner spend={balance.data.spend} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
            <WalletCard wallet={balance.data.wallet} />
            <ProviderCard provider={balance.data.provider} />
          </div>
        </div>
      ) : (
        <BalanceCardsSkeleton />
      )}
    </Reveal>
  );
}

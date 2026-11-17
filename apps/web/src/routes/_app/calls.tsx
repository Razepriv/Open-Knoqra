import { createFileRoute } from '@tanstack/react-router';
import { useCallSession } from '../../components/calls/call-session';
import { CallsPageSkeleton, LiveCallSkeleton } from '../../components/calls/call-skeletons';
import { Dialer } from '../../components/calls/dialer';
import { LiveCallPanel, MicBlockedPanel } from '../../components/calls/live-call-panel';
import { CallsPanel } from '../../components/calls/recents-list';
import { WalletPanel } from '../../components/calls/wallet-panel';
import { PageRibbon } from '../../components/shell/ribbon';
import { deskSlot } from '../../extensions';
import { type CallsSearch, callsSearch } from '../../lib/dial';
import { VoiceError } from '../../lib/voice';

export const Route = createFileRoute('/_app/calls')({
  staticData: { title: 'Calls' },
  validateSearch: (search: Record<string, unknown>): CallsSearch => callsSearch(search),
  pendingComponent: CallsPageSkeleton,
  component: CallsPage,
});

function CallsPage() {
  const { contactId, to } = Route.useSearch();
  const session = useCallSession();
  const micBlocked = session.error instanceof VoiceError && session.error.code === 'mic_denied';
  const CallScreenPanel = deskSlot('CallScreenPanel');
  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(320px,430px)_minmax(0,1fr)]">
      {/* Keyed so a new link (from Contact 360 or Call back, say) starts the dialer afresh. */}
      <Dialer key={`${contactId ?? ''}|${to ?? ''}`} initialContactId={contactId} initialTo={to} />
      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        {micBlocked ? (
          <MicBlockedPanel />
        ) : session.current ? (
          <>
            <LiveCallPanel call={session.current} />
            {CallScreenPanel ? <CallScreenPanel call={session.current} /> : null}
          </>
        ) : session.loadingCurrent ? (
          <LiveCallSkeleton />
        ) : (
          <CallsPanel />
        )}
      </div>
      <PageRibbon label="Wallet">
        <WalletPanel />
      </PageRibbon>
    </div>
  );
}

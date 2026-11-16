import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { CallDock } from '../components/calls/call-dock';
import { CallSessionProvider } from '../components/calls/call-session';
import { IncomingCall } from '../components/calls/incoming-call';
import { OutcomeDialog } from '../components/calls/outcome-dialog';
import { LicenseGate } from '../components/license/license-gate';
import { OutageState } from '../components/outage';
import { AppShell } from '../components/shell/app-shell';
import { ShellSkeleton } from '../components/skeletons/shell-skeleton';
import { isUnreachable, signInSearch, useMe } from '../lib/api';
import { currentSession } from '../lib/auth';
import { needsLicense, useLicense } from '../lib/license';
import { useAnalyticsConsent } from '../lib/observability/use-analytics-consent';
import { loadFailed } from '../lib/query-state';
import { useRealtime } from '../lib/realtime';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Shown in the shell's top bar and the document title. */
    title?: string;
  }
}

/**
 * The outage on its own, with no shell around it: it is the page's main. It fills the root
 * canvas (flex-1), which already sets the height and padding; min-h-dvh here would overflow it.
 */
function OutageMain(props: { onRetry: () => void; retrying: boolean }) {
  return (
    <main id="main" tabIndex={-1} className="flex flex-1 flex-col outline-none">
      <OutageState {...props} />
    </main>
  );
}

/** The signed-in Desk: every page under it shares the rail, top bar and session check. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const state = await currentSession();
    if (state.status === 'unauthenticated') {
      throw redirect({
        to: '/sign-in',
        search: signInSearch(location.pathname, location.searchStr),
      });
    }
    // Unreachable: we could not ask, so render the outage state instead of signing the user out.
    return { session: state.status === 'authenticated' ? state.session : null };
  },
  // While the session check runs: the shell frame with the target page's outline inside.
  pendingComponent: ShellSkeleton,
  component: AppLayout,
});

function AppLayout() {
  const { session } = Route.useRouteContext();
  const router = useRouter();
  const me = useMe({ enabled: session !== null });
  // Self-hosted instances stay locked until a license key is entered; cloud answers at once.
  const license = useLicense(session !== null);
  useAnalyticsConsent(me.data);
  const [rechecking, setRechecking] = useState(false);

  if (!session) {
    const recheck = () => {
      setRechecking(true);
      router.invalidate().finally(() => setRechecking(false));
    };
    return <OutageMain onRetry={recheck} retrying={rechecking} />;
  }
  // A failed background refetch keeps the Desk: only a first load that cannot reach us is an outage.
  if (loadFailed(me) && isUnreachable(me.error)) {
    return <OutageMain onRetry={() => me.refetch()} retrying={me.isFetching} />;
  }
  // Until the edition is known the Desk is not drawn, so a self-hosted instance never flashes it.
  // If the check itself fails the Desk loads anyway: the API enforces the license on its own.
  if (license.isPending) return <ShellSkeleton />;
  if (license.data && needsLicense(license.data)) {
    return <LicenseGate status={license.data} email={me.data?.user.email ?? session.user.email} />;
  }
  const user = {
    name: me.data?.user.name ?? session.user.name,
    email: me.data?.user.email ?? session.user.email,
  };
  return (
    <AppShell user={user}>
      <CallLayer>
        <Outlet />
      </CallLayer>
    </AppShell>
  );
}

/**
 * The phone line for every desk page: one realtime socket, the call session, the dock that follows
 * a call across pages, the incoming call dialog and the outcome dialog.
 */
function CallLayer({ children }: { children: ReactNode }) {
  const { status } = useRealtime();
  return (
    <CallSessionProvider realtimeStatus={status}>
      {children}
      <CallDock />
      <IncomingCall />
      <OutcomeDialog />
    </CallSessionProvider>
  );
}

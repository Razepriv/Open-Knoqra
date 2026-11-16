import { SkeletonPanel, SkeletonShell, SkeletonStatus, SkeletonText } from '@knoqra/ui';
import { useRouterState } from '@tanstack/react-router';
import { type ComponentType, type ReactNode, useContext } from 'react';
import { NAV_ITEMS } from '../../lib/nav-items';
import { type AppSkeletonId, appSkeletonFor, authSkeletonFor } from '../../lib/skeleton-routes';
import { CallsPageSkeleton, WalletRibbonSkeleton } from '../calls/call-skeletons';
import { InboxPageSkeleton, RibbonSkeleton } from '../inbox/inbox-skeletons';
import { NumbersPageSkeleton } from '../numbers/numbers-page-skeleton';
import { SetupPageSkeleton } from '../setup/setup-skeletons';
import { RibbonContext } from '../shell/ribbon';
import { UsagePageSkeleton } from '../usage/usage-page-skeleton';
import { AuthSkeleton } from './auth-skeleton';
import { ConsentRibbonSkeleton, Contact360Skeleton } from './contact360-skeleton';
import { ContactsSkeleton } from './contacts-skeleton';
import { ImportSkeleton } from './import-skeleton';
import { SettingsSkeleton } from './settings-skeleton';
import { TasksSkeleton } from './tasks-skeleton';
import { TodaySkeleton, WorkspaceRibbonSkeleton } from './today-skeleton';

/**
 * A signed-in path no outline knows (every page has its own): one panel with an eyebrow, a title
 * and a paragraph, so the shell is never empty.
 */
function AppDefaultSkeleton() {
  return (
    <SkeletonPanel
      data-skeleton="app-default"
      label="Loading this page"
      className="flex flex-1 flex-col justify-between gap-12 p-6 sm:p-10"
    >
      <SkeletonText size="mono" widths={['7rem']} lineHeight={12} />
      <span aria-hidden="true" className="flex flex-col gap-5">
        <SkeletonText
          lines={2}
          widths={['30rem', 'min(70%, 18rem)']}
          lineHeight="clamp(35.28px, 4.9vw, 62.72px)"
        />
        <SkeletonText lines={2} widths={['30rem', 'min(60%, 16rem)']} lineHeight={24.375} />
      </span>
      <span />
    </SkeletonPanel>
  );
}

/**
 * A page's own pending outline drawn inside the shell outline. Those outlines announce each block;
 * here the shell speaks once for the page, so the blocks are hidden from assistive tech.
 */
function Quiet({ id, label, children }: { id?: string; label?: string; children: ReactNode }) {
  return (
    <div data-skeleton={id} className="contents">
      {label ? <SkeletonStatus label={label} /> : null}
      <div aria-hidden="true" className="contents">
        {children}
      </div>
    </div>
  );
}

const CallsOutline = () => (
  <Quiet id="calls" label="Loading calls">
    <CallsPageSkeleton />
  </Quiet>
);
const InboxOutline = () => (
  <Quiet id="inbox" label="Loading the inbox">
    <InboxPageSkeleton />
  </Quiet>
);
const InboxThreadOutline = () => (
  <Quiet id="inbox-thread" label="Loading the inbox">
    <InboxPageSkeleton />
  </Quiet>
);
const UsageOutline = () => (
  <Quiet id="usage" label="Loading usage">
    <UsagePageSkeleton />
  </Quiet>
);
const NumbersOutline = () => (
  <Quiet id="numbers" label="Loading numbers">
    <NumbersPageSkeleton />
  </Quiet>
);
const SetupOutline = () => (
  <Quiet id="setup" label="Loading setup">
    <SetupPageSkeleton />
  </Quiet>
);
const WalletRibbonOutline = () => (
  <Quiet>
    <WalletRibbonSkeleton />
  </Quiet>
);
const ContactRibbonOutline = () => (
  <Quiet>
    <RibbonSkeleton />
  </Quiet>
);

interface PageOutline {
  page: ComponentType;
  ribbon?: ComponentType;
  /** Width of the top bar title, close to the real page title. */
  title: number;
}

const OUTLINES: Record<AppSkeletonId, PageOutline> = {
  today: { page: TodaySkeleton, ribbon: WorkspaceRibbonSkeleton, title: 72 },
  tasks: { page: TasksSkeleton, title: 64 },
  contacts: { page: ContactsSkeleton, title: 112 },
  'contact-360': { page: Contact360Skeleton, ribbon: ConsentRibbonSkeleton, title: 92 },
  'contacts-import': { page: ImportSkeleton, title: 190 },
  settings: { page: SettingsSkeleton, title: 96 },
  calls: { page: CallsOutline, ribbon: WalletRibbonOutline, title: 64 },
  inbox: { page: InboxOutline, title: 64 },
  'inbox-thread': { page: InboxThreadOutline, ribbon: ContactRibbonOutline, title: 64 },
  usage: { page: UsageOutline, title: 64 },
  numbers: { page: NumbersOutline, title: 96 },
  setup: { page: SetupOutline, title: 64 },
  'app-default': { page: AppDefaultSkeleton, title: 96 },
};

/** The page outline alone, for a page pending inside the real shell. */
function PageSkeleton({ id }: { id: AppSkeletonId }) {
  const Page = OUTLINES[id].page;
  return <Page />;
}

/**
 * The Desk while the session check runs: the shell frame with the target page's outline (and its
 * ribbon) inside the one <main>.
 */
export function ShellSkeleton() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const outline = OUTLINES[appSkeletonFor(pathname, searchStr)];
  const Page = outline.page;
  const Ribbon = outline.ribbon;
  return (
    <SkeletonShell
      data-skeleton="shell"
      railItems={NAV_ITEMS.length + 1}
      titleWidth={outline.title}
      ribbon={Ribbon ? <Ribbon /> : false}
    >
      <Page />
    </SkeletonShell>
  );
}

/**
 * The router's default pending view. Inside the real shell (a page of `_app` without its own
 * pendingComponent) it is the page outline only; otherwise the auth or shell outline for the path.
 */
export function RoutePending() {
  const inShell = useContext(RibbonContext) !== null;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  if (inShell) return <PageSkeleton id={appSkeletonFor(pathname, searchStr)} />;
  const auth = authSkeletonFor(pathname);
  if (auth) return <AuthSkeleton route={auth} />;
  return <ShellSkeleton />;
}

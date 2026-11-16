import { Panel } from '@knoqra/ui';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CapabilityTiles } from '../../components/numbers/capability-tiles';
import { NumberList } from '../../components/numbers/number-list';
import { NumbersPageSkeleton } from '../../components/numbers/numbers-page-skeleton';
import { SetupChecks } from '../../components/numbers/setup-checks';
import { BlockError } from '../../components/usage/usage-states';
import { useMe } from '../../lib/api';
import { canBuyNumbers } from '../../lib/number-purchase';
import { useNumbers } from '../../lib/numbers';
import { type Setup, useSetup } from '../../lib/setup';
import { focusRing } from '../../lib/ui-classes';

const MANAGER_ROLES = new Set(['owner', 'admin']);
const linkClass = `inline-flex h-[34px] items-center rounded-full border border-[color:var(--pillBorder)] bg-[color:var(--pill)] px-3 font-medium text-[13px] [box-shadow:var(--pillShadow)] ${focusRing}`;

export const Route = createFileRoute('/_app/numbers')({
  staticData: { title: 'Numbers' },
  pendingComponent: NumbersPageSkeleton,
  component: NumbersPage,
});

function SetupLink({ setup }: { setup: Setup }) {
  if (setup.completedAt === null) {
    return (
      <Link
        to="/setup"
        search={setup.currentStep ? { step: setup.currentStep } : {}}
        className={linkClass}
      >
        Continue setup
      </Link>
    );
  }
  return (
    <Link to="/setup" className={linkClass}>
      Run setup again
    </Link>
  );
}

function NumbersPage() {
  const me = useMe();
  const setup = useSetup();
  const numbers = useNumbers();

  const header = (
    <Panel className="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
      <h1 className="font-[family-name:var(--font-display)] text-[34px] leading-none tracking-[-0.02em]">
        Numbers
      </h1>
      {setup.data ? <SetupLink setup={setup.data} /> : null}
    </Panel>
  );

  // An error shows only while there is nothing to show; a failed background refetch keeps the data.
  const missing = [setup, numbers, me].find((query) => query.isError && !query.data);
  if (missing) {
    const retry = () => {
      void setup.refetch();
      void numbers.refetch();
      void me.refetch();
    };
    return (
      <div className="flex flex-col gap-4">
        {header}
        <Panel className="p-5 sm:p-6">
          <BlockError
            what="your numbers and setup checks"
            error={missing.error}
            onRetry={retry}
            retrying={setup.isFetching || numbers.isFetching || me.isFetching}
          />
        </Panel>
      </div>
    );
  }
  if (!setup.data || !numbers.data || !me.data) return <NumbersPageSkeleton />;

  const canManage = MANAGER_ROLES.has(me.data.organization.role);
  const connected = setup.data.checks.find((check) => check.id === 'credential')?.status === 'pass';
  return (
    <div className="flex flex-col gap-4">
      {header}
      <SetupChecks setup={setup.data} />
      <CapabilityTiles setup={setup.data} numbers={numbers.data} />
      <NumberList
        numbers={numbers.data}
        canManage={canManage}
        connected={connected}
        canBuy={canBuyNumbers(me.data.organization.role)}
      />
    </div>
  );
}

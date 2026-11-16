import { Button, Panel } from '@knoqra/ui';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { FormAlert } from '../../components/form-alert';
import { OutageState } from '../../components/outage';
import { SetupPageSkeleton } from '../../components/setup/setup-skeletons';
import { SetupWizard, useCloseSetup } from '../../components/setup/setup-wizard';
import { isUnreachable } from '../../lib/api';
import { loadFailed } from '../../lib/query-state';
import { initialStep, stepToPin, useSetup, useUpdateSetup } from '../../lib/setup';
import { parseSetupStep, type SetupStep } from '../../lib/setup-steps';

interface SetupSearch {
  step?: SetupStep;
}

export const Route = createFileRoute('/_app/setup')({
  staticData: { title: 'Setup' },
  validateSearch: (search: Record<string, unknown>): SetupSearch => {
    const step = parseSetupStep(search.step);
    return step ? { step } : {};
  },
  pendingComponent: SetupPageSkeleton,
  component: SetupPage,
});

function SetupPage() {
  const { step: urlStep } = Route.useSearch();
  const navigate = useNavigate();
  const setup = useSetup();
  const { mutate: saveProgress } = useUpdateSetup();
  const close = useCloseSetup(() => void navigate({ to: '/' }));
  // A bare /setup opens on the resumed step, then keeps it in the URL: saving a step refetches
  // setup and moves `currentStep` on, which must not move the wizard off the step being worked on.
  const pin = setup.data ? stepToPin(urlStep, setup.data) : undefined;
  useEffect(() => {
    if (pin) void navigate({ to: '/setup', search: { step: pin }, replace: true });
  }, [pin, navigate]);

  if (loadFailed(setup) && isUnreachable(setup.error)) {
    return <OutageState onRetry={() => void setup.refetch()} retrying={setup.isFetching} />;
  }
  if (loadFailed(setup)) {
    return (
      <Panel className="flex flex-col items-start gap-4 p-6 sm:p-8">
        <FormAlert message="We could not load your setup." />
        <Button variant="ghost" onClick={() => void setup.refetch()}>
          Try again
        </Button>
      </Panel>
    );
  }
  if (!setup.data) return <SetupPageSkeleton />;

  const step = initialStep(urlStep, setup.data);
  const goTo = (next: SetupStep) => {
    saveProgress({ lastStep: next });
    void navigate({ to: '/setup', search: { step: next } });
  };
  return <SetupWizard setup={setup.data} step={step} onStep={goTo} onClose={close} />;
}

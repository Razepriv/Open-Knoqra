import type { components } from '@knoqra/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, throwIfFailed } from './api';
import { parseSetupStep, SETUP_STEPS, type SetupStep } from './setup-steps';

export { parseSetupStep, SETUP_STEPS, type SetupStep };

export type Setup = components['schemas']['Setup'];
export type SetupCheck = components['schemas']['SetupCheck'];
export type UpdateSetup = components['schemas']['UpdateSetup'];

export const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  connect: 'Connect Telnyx',
  number: 'Choose a number',
  audio: 'Test audio',
  test_call: 'Test call',
};

export const setupKey = ['setup'] as const;

/** `/setup`, or `/setup?step=<step>` to open a particular step. */
export function setupPath(step?: SetupStep): string {
  return step ? `/setup?step=${step}` : '/setup';
}

/** Where the wizard opens: the URL's step, else where the person left off, else the first step not done. */
export function initialStep(
  fromUrl: SetupStep | undefined,
  setup: Pick<Setup, 'currentStep' | 'lastStep'>,
): SetupStep {
  return fromUrl ?? setup.lastStep ?? setup.currentStep ?? 'connect';
}

/**
 * The step to write into a bare `/setup` URL. A visit stays on the step it opened on: saving a step
 * changes the server's `currentStep`, and that must not move the person off the step they are on.
 */
export function stepToPin(
  fromUrl: SetupStep | undefined,
  setup: Pick<Setup, 'currentStep' | 'lastStep'>,
): SetupStep | undefined {
  return fromUrl ? undefined : initialStep(undefined, setup);
}

export function nextStep(step: SetupStep): SetupStep | undefined {
  return SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1];
}

/** The server words its credential check differently for the fake provider; development only. */
export function isFakeProvider(setup: Pick<Setup, 'checks'>): boolean {
  const check = setup.checks.find((item) => item.id === 'credential');
  return check?.detail.includes('fake provider') ?? false;
}

export function useSetup() {
  return useQuery({
    queryKey: setupKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(await api.GET('/api/v1/setup', { signal }), 'Could not load your setup.'),
  });
}

export function useUpdateSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (update: UpdateSetup): Promise<Setup> =>
      throwIfFailed(
        await api.PATCH('/api/v1/setup', { body: update }),
        'Could not save your setup progress.',
      ),
    onSuccess: (setup) => {
      queryClient.setQueryData(setupKey, setup);
    },
  });
}

import type { components } from '@knoqra/api-client';

/**
 * The setup wizard's steps and the parser for `?step=`. Constants only: the setup route's search
 * validation loads with the route tree, so this module must not pull in the API client or queries.
 */

export type SetupStep = NonNullable<components['schemas']['Setup']['currentStep']>;

export const SETUP_STEPS = [
  'connect',
  'number',
  'audio',
  'test_call',
] as const satisfies readonly SetupStep[];

export function parseSetupStep(value: unknown): SetupStep | undefined {
  return SETUP_STEPS.find((step) => step === value);
}

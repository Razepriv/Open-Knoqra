import type { Env } from '../env';

export type Edition = 'cloud' | 'selfhost';

/**
 * Which half of KNOQRA this deployment runs. Only the exact value `cloud` turns on billing and
 * turns off the license check; unset or anything else is a self-hosted instance.
 */
export function editionOf(env: Pick<Env, 'KNOQRA_EDITION'>): Edition {
  return env.KNOQRA_EDITION?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'selfhost';
}

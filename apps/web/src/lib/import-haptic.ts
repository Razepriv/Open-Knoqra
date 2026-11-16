import type { HapticPattern } from './haptics';
import type { ImportSummary } from './import-runner';

/** What a finished import feels like: done is a success, a failure is an error, a cancel is silent. */
export function importHaptic(status: ImportSummary['status']): HapticPattern | null {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return null;
}

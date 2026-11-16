import { useMe } from './api';
import { browserTimeZone } from './timezones';

/** The zone that decides what "today" means: the saved preference, else the browser's own. */
export function useEffectiveTimeZone(): string {
  const me = useMe();
  return me.data?.prefs.timezone || browserTimeZone() || 'UTC';
}

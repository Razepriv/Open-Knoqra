import { useEffect } from 'react';
import type { Me } from '../api';
import { syncAnalytics } from './analytics';

/**
 * Keeps product analytics in step with the signed-in user's consent: loading `me` does nothing,
 * a change of user or consent re-syncs, and unmounting turns capturing off. A failed SDK load
 * leaves analytics off and never reaches render.
 */
export function useAnalyticsConsent(me: Me | undefined): void {
  const userId = me?.user.id;
  const consent = me?.prefs.analyticsConsent;

  useEffect(() => {
    if (userId === undefined || consent === undefined) return;
    syncAnalytics({ userId, consent }).catch(() => undefined);
  }, [userId, consent]);

  useEffect(() => () => void syncAnalytics(null).catch(() => undefined), []);
}

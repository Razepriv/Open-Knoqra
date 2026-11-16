import { CRON_JOBS } from '../cron/jobs';
import {
  cronCheck,
  type DurableObjectProbe,
  databaseCheck,
  durableObjectsCheck,
  emailCheck,
  migrationsCheck,
  posthogCheck,
  providerCheck,
  queueCheck,
  sentryCheck,
} from './checks';
import type { HealthCheck } from './types';

/** Durable Object bindings the health check probes (wrangler.jsonc `durable_objects`). */
export const DURABLE_OBJECT_PROBES: readonly DurableObjectProbe[] = [
  { binding: 'ORG_REALTIME', label: 'Realtime' },
  { binding: 'USER_CALL_LOCK', label: 'Call lock' },
];

/** The deep health report, in display order. Only the database is critical. */
export const HEALTH_CHECKS: readonly HealthCheck[] = [
  databaseCheck,
  migrationsCheck,
  queueCheck,
  durableObjectsCheck(DURABLE_OBJECT_PROBES),
  cronCheck(CRON_JOBS),
  providerCheck,
  emailCheck,
  sentryCheck,
  posthogCheck,
];

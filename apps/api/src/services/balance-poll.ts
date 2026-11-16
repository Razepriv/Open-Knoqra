import { type Database, providerBalanceSnapshot, withTenant } from '@knoqra/db';
import { ProviderApiError } from '@knoqra/providers';
import type { Env } from '../env';
import { logger } from '../lib/logger';
import type { ProviderSnapshotJson } from '../lib/m4-schemas';
import { openProviderAccess, type ProviderAccess } from '../lib/provider-access';

type Fetched = { status: 'ok' | 'auth_failed' | 'unavailable'; balanceMicros: number | null };

async function fetchSnapshot(access: Exclude<ProviderAccess, { kind: 'none' }>): Promise<Fetched> {
  try {
    const { balanceMicros } = await access.balance.fetchBalance();
    return { status: 'ok', balanceMicros };
  } catch (error) {
    const authFailed = error instanceof ProviderApiError && [401, 403].includes(error.status);
    logger.warn('balance.poll_failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
      authFailed,
    });
    return { status: authFailed ? 'auth_failed' : 'unavailable', balanceMicros: null };
  }
}

/**
 * Reads the provider balance for one organization and stores a snapshot. Returns null (and
 * writes nothing) when there is no provider. Provider errors become a non-ok snapshot, never a throw.
 */
export async function pollOrgBalance(
  db: Database,
  env: Env,
  orgId: string,
  opts: { access?: ProviderAccess; now?: Date; fakeBalanceMicros?: number } = {},
): Promise<ProviderSnapshotJson | null> {
  const access =
    opts.access ??
    (await withTenant(db, orgId, (tx) =>
      openProviderAccess(tx, env, orgId, { fakeBalanceMicros: opts.fakeBalanceMicros }),
    ));
  if (access.kind === 'none') return null;
  // Outside any transaction: the provider can be slow.
  const fetched = await fetchSnapshot(access);
  const capturedAt = opts.now ?? new Date();
  await withTenant(db, orgId, (tx) =>
    tx.insert(providerBalanceSnapshot).values({
      organizationId: orgId,
      provider: access.kind,
      status: fetched.status,
      balanceMicros: fetched.balanceMicros,
      currency: 'USD',
      capturedAt,
    }),
  );
  return {
    status: fetched.status,
    balanceMicros: fetched.balanceMicros,
    capturedAt: capturedAt.toISOString(),
  };
}

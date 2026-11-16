import { callCostMicros, isTerminal } from '@knoqra/core';
import { call, numberOrder, providerBalanceSnapshot, type Tx } from '@knoqra/db';
import {
  type BalanceProvider,
  FAKE_ORDER_ID_PREFIX,
  FakeProvider,
  type NumberPurchaseProvider,
  type NumbersProvider,
  type ProviderUsage,
  type VoiceProvider,
} from '@knoqra/providers';
import { and, desc, eq, gt, inArray, isNotNull, like } from 'drizzle-orm';
import {
  buildProvider,
  type ConnectorProvider,
  openConnectionSecret,
} from '../connectors/registry';
import type { Env } from '../env';
import { logger } from './logger';
import { isValidMasterKey, SecretEnvelopeError } from './secret-envelope';
import { loadVoiceChoice } from './voice-provider';

export type ProviderAccess =
  | {
      kind: 'fake' | ConnectorProvider;
      numbers: NumbersProvider;
      purchase: NumberPurchaseProvider;
      /**
       * Where a bought number is attached: the Telnyx credential connection or the Plivo
       * application. Null on the fake provider.
       */
      connectionId: string | null;
      balance: BalanceProvider;
      usage: Pick<VoiceProvider, 'fetchUsage'>;
    }
  | { kind: 'none' };

type AccessEnv = Pick<
  Env,
  'PROVIDER' | 'APP_ENV' | 'FAKE_WEBHOOK_SECRET' | 'CREDENTIALS_MASTER_KEY' | 'API_PUBLIC_ORIGIN'
>;

const TERMINAL_STATES = ['completed', 'failed', 'busy', 'no_answer', 'canceled'] as const;

/** One usage record per billed terminal call of the organization (RLS-scoped `tx`). */
export async function fakeUsageFromCalls(tx: Tx): Promise<ProviderUsage[]> {
  const rows = await tx
    .select({
      id: call.id,
      state: call.state,
      billableSeconds: call.billableSeconds,
      endedAt: call.endedAt,
      providerCostMicros: call.providerCostMicros,
    })
    .from(call)
    .where(
      and(
        inArray(call.state, TERMINAL_STATES),
        gt(call.billableSeconds, 0),
        isNotNull(call.endedAt),
      ),
    );
  const usage: ProviderUsage[] = [];
  for (const row of rows) {
    if (!isTerminal(row.state) || !row.billableSeconds || !row.endedAt) continue;
    usage.push({
      service: 'voice',
      quantity: row.billableSeconds,
      unit: 'second',
      // The fake bills exactly what a call was estimated to cost (flat for calls without one).
      costMicros: row.providerCostMicros ?? callCostMicros(row.billableSeconds),
      occurredAt: row.endedAt.toISOString(),
      providerRef: `fake_call_${row.id}`,
    });
  }
  return usage;
}

/**
 * The fake provider models an account whose balance does not change by itself: it keeps the
 * newest `ok` fake snapshot (for example one seeded by the dev endpoint). Undefined when none.
 */
async function stickyFakeBalance(tx: Tx): Promise<number | undefined> {
  const [row] = await tx
    .select({ balanceMicros: providerBalanceSnapshot.balanceMicros })
    .from(providerBalanceSnapshot)
    .where(
      and(eq(providerBalanceSnapshot.provider, 'fake'), eq(providerBalanceSnapshot.status, 'ok')),
    )
    .orderBy(desc(providerBalanceSnapshot.capturedAt))
    .limit(1);
  return row?.balanceMicros ?? undefined;
}

/**
 * E.164 numbers this organization bought on the fake provider (RLS-scoped `tx`): every order the
 * fake itself accepted. The fake never answers `pending`, so such an order is bought even while it
 * is still `pending` here, waiting for a sync to complete and assign it.
 */
async function fakeOrderedNumbers(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ e164: numberOrder.e164 })
    .from(numberOrder)
    .where(
      and(
        eq(numberOrder.provider, 'fake'),
        inArray(numberOrder.status, ['pending', 'completed']),
        like(numberOrder.providerOrderId, `${FAKE_ORDER_ID_PREFIX}%`),
      ),
    );
  return rows.map((r) => r.e164);
}

/**
 * The provider handle for an organization. A connection whose secret cannot be opened (no or wrong
 * master key) is `none`, logged by organization id only: never a key, never a ciphertext.
 */
export async function openProviderAccess(
  tx: Tx,
  env: AccessEnv,
  orgId: string,
  opts: { fetch?: typeof fetch; fakeBalanceMicros?: number } = {},
): Promise<ProviderAccess> {
  const choice = await loadVoiceChoice(tx, env);
  if (choice.kind === 'none') return { kind: 'none' };
  if (choice.kind === 'fake') {
    const provider = new FakeProvider({
      webhookSecret: env.FAKE_WEBHOOK_SECRET ?? '',
      balanceMicros: opts.fakeBalanceMicros ?? (await stickyFakeBalance(tx)),
      usage: await fakeUsageFromCalls(tx),
      ordered: await fakeOrderedNumbers(tx),
    });
    return {
      kind: 'fake',
      numbers: provider,
      purchase: provider,
      connectionId: null,
      balance: provider,
      usage: provider,
    };
  }
  const masterKeyBase64 = env.CREDENTIALS_MASTER_KEY;
  if (!isValidMasterKey(masterKeyBase64)) {
    logger.warn('provider.access_unavailable', { orgId });
    return { kind: 'none' };
  }
  const { connection } = choice;
  try {
    const secret = await openConnectionSecret(connection, masterKeyBase64);
    const { provider } = buildProvider(connection, secret, { env, fetch: opts.fetch });
    return {
      kind: choice.kind,
      numbers: provider,
      purchase: provider,
      connectionId: connection.connectionId,
      balance: provider,
      usage: provider,
    };
  } catch (error) {
    if (!(error instanceof SecretEnvelopeError)) throw error;
    logger.warn('provider.access_unavailable', { orgId });
    return { kind: 'none' };
  }
}

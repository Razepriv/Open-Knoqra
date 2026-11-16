// M2/M4/M4b money and numbers: the wallet, its append-only ledger, phone numbers, number quotes and
// orders (each held by a ledger reservation), usage events and reconciliation reports.
import { BATCH_SIZE, microIso, WINDOW_END_MS, WINDOW_MS } from './generate';
import { msBetween, type OrgContext, pad, WINDOW_START_MS } from './phase1';
import { hexId, int, mulberry32, pick, type Rand, weighted } from './random';

export interface WalletRow {
  id: string;
  organization_id: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: string;
  organization_id: string;
  wallet_id: string;
  kind: 'credit' | 'adjust' | 'reserve' | 'capture' | 'release';
  balance_delta_micros: number;
  held_delta_micros: number;
  reservation_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  idempotency_key: string;
  note: string | null;
  actor_user_id: string | null;
  created_at: string;
}

export interface PhoneNumberRow {
  id: string;
  organization_id: string;
  provider: 'fake';
  provider_number_id: string;
  e164: string;
  status: 'active' | 'pending' | 'inactive';
  voice: boolean;
  sms: boolean;
  mms: boolean;
  whatsapp: boolean;
  ten_dlc_status: string;
  whatsapp_status: string;
  assigned_use: string;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface QuoteRow {
  id: string;
  organization_id: string;
  provider: 'fake';
  e164: string;
  upfront_micros: number;
  monthly_micros: number;
  currency: 'USD';
  expires_at: string;
  created_by: string;
  created_at: string;
}

export interface OrderRow {
  id: string;
  organization_id: string;
  quote_id: string;
  provider: 'fake';
  e164: string;
  idempotency_key: string;
  status: 'pending' | 'completed' | 'failed';
  provider_order_id: string | null;
  upfront_micros: number;
  monthly_micros: number;
  reservation_id: string;
  failure_code: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface UsageEventRow {
  id: string;
  organization_id: string;
  user_id: string;
  service: string;
  quantity: number;
  unit: string;
  cost_micros: number;
  provider: string;
  idempotency_key: string;
  occurred_at: string;
  created_at: string;
}

export interface ReconciliationRow {
  id: string;
  organization_id: string;
  period_date: string;
  service: 'voice';
  trigger: 'cron' | 'manual';
  status: 'matched' | 'adjusted' | 'needs_review' | 'provider_unavailable';
  captured_micros: number;
  provider_micros: number | null;
  ledger_micros: number;
  drift_micros: number;
  adjust_entry_id: string | null;
  actor_user_id: string | null;
  created_at: string;
}

/** The development starter credit ensureWallet grants (apps/api services/ledger.ts). */
export const STARTER_CREDIT = {
  key: 'starter-credit',
  note: 'Development starter credit',
  micros: 5_000_000,
} as const;

const UPFRONT_MICROS = 1_000_000;
const MONTHLY_MICROS = 1_150_000;

export function generateWallet(ctx: OrgContext): WalletRow {
  const created = new Date(WINDOW_START_MS - 86_400_000).toISOString();
  return {
    id: hexId(mulberry32(ctx.orgIndex + 31), 'wl'),
    organization_id: ctx.orgId,
    created_at: created,
    updated_at: created,
  };
}

/** `+1 212 555 9xxx` numbers (organization B from 9500), mostly active. */
export function generateNumbers(rand: Rand, ctx: OrgContext, n: number): PhoneNumberRow[] {
  return Array.from({ length: n }, (_, i) => {
    const r = rand();
    const created = new Date(msBetween(rand, WINDOW_START_MS, WINDOW_END_MS)).toISOString();
    return {
      id: hexId(rand, 'pn'),
      organization_id: ctx.orgId,
      provider: 'fake',
      provider_number_id: `fake-number-${ctx.orgIndex}-${pad(i, 4)}`,
      e164: `+1212555${9000 + ctx.orgIndex * 500 + i}`,
      status: r < 0.9 ? 'active' : r < 0.95 ? 'pending' : 'inactive',
      voice: true,
      sms: rand() < 0.9,
      mms: rand() < 0.5,
      whatsapp: rand() < 0.3,
      ten_dlc_status: pick(rand, ['registered', 'pending', 'none', 'not_required'] as const),
      whatsapp_status: pick(rand, ['none', 'approved', 'pending'] as const),
      assigned_use: pick(rand, ['calls_and_messages', 'calls', 'messages', 'unassigned'] as const),
      last_synced_at: new Date(WINDOW_END_MS).toISOString(),
      created_at: created,
      updated_at: created,
    };
  });
}

export interface OrderSet {
  quotes: QuoteRow[];
  orders: OrderRow[];
  /** Each order's reservation and, unless pending, its capture or release, oldest first. */
  ledger: LedgerRow[];
}

/**
 * A quarter of the orders completed (one per owned number, so open orders keep unique numbers),
 * 2.5% pending, the rest failed. Every order holds a reservation, closed unless pending.
 */
export function generateOrders(
  rand: Rand,
  ctx: OrgContext,
  walletId: string,
  n: number,
  numbers: readonly PhoneNumberRow[],
): OrderSet {
  const completed = Math.min(numbers.length, Math.floor(n * 0.25));
  const pending = Math.floor(n * 0.025);
  const times = Array.from({ length: n }, () =>
    msBetween(rand, WINDOW_START_MS, WINDOW_END_MS - 60_000),
  ).sort((a, b) => a - b);
  const quotes: QuoteRow[] = [];
  const orders: OrderRow[] = [];
  const ledger: LedgerRow[] = [];
  for (let i = 0; i < n; i++) {
    const at = times[i] as number;
    const status = i < completed ? 'completed' : i < completed + pending ? 'pending' : 'failed';
    const e164 =
      status === 'completed'
        ? (numbers[i] as PhoneNumberRow).e164
        : status === 'pending'
          ? `+1212555${8000 + ctx.orgIndex * 500 + i}`
          : `+1212555${7000 + int(rand, 1000)}`;
    const quoteId = hexId(rand, 'nq');
    const orderId = hexId(rand, 'no');
    const reserveId = hexId(rand, 'le');
    const created = microIso(at, 0);
    quotes.push({
      id: quoteId,
      organization_id: ctx.orgId,
      provider: 'fake',
      e164,
      upfront_micros: UPFRONT_MICROS,
      monthly_micros: MONTHLY_MICROS,
      currency: 'USD',
      expires_at: new Date(at + 600_000).toISOString(),
      created_by: ctx.ownerId,
      created_at: new Date(at - 30_000).toISOString(),
    });
    orders.push({
      id: orderId,
      organization_id: ctx.orgId,
      quote_id: quoteId,
      provider: 'fake',
      e164,
      idempotency_key: `perf-order-${i}`,
      status,
      provider_order_id: status === 'failed' ? null : `fake-order-${orderId.slice(3)}`,
      upfront_micros: UPFRONT_MICROS,
      monthly_micros: MONTHLY_MICROS,
      reservation_id: reserveId,
      failure_code: status === 'failed' ? 'number_unavailable' : null,
      created_by: ctx.ownerId,
      created_at: created,
      updated_at: microIso(at + 5000, 0),
    });
    const base = {
      organization_id: ctx.orgId,
      wallet_id: walletId,
      ref_type: 'number_order',
      ref_id: orderId,
      note: null,
      actor_user_id: ctx.ownerId,
    };
    ledger.push({
      ...base,
      id: reserveId,
      kind: 'reserve',
      balance_delta_micros: 0,
      held_delta_micros: UPFRONT_MICROS,
      reservation_id: null,
      idempotency_key: `perf-order-${i}-reserve`,
      created_at: created,
    });
    if (status !== 'pending') {
      ledger.push({
        ...base,
        id: hexId(rand, 'le'),
        kind: status === 'completed' ? 'capture' : 'release',
        balance_delta_micros: status === 'completed' ? -UPFRONT_MICROS : 0,
        held_delta_micros: -UPFRONT_MICROS,
        reservation_id: reserveId,
        idempotency_key: `perf-order-${i}-close`,
        created_at: microIso(at + 5000, 0),
      });
    }
  }
  return { quotes, orders, ledger };
}

export interface ReconciliationSet {
  reports: ReconciliationRow[];
  /** The adjust entries the `adjusted` reports point at. */
  ledger: LedgerRow[];
}

/** One report per UTC day back from the window end; one in ten adjusted with its ledger entry. */
export function generateReconciliations(
  rand: Rand,
  ctx: OrgContext,
  walletId: string,
  n: number,
): ReconciliationSet {
  const reports: ReconciliationRow[] = [];
  const ledger: LedgerRow[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const dayMs = WINDOW_END_MS - (i + 1) * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const createdMs = dayMs + 86_400_000 + 2 * 3_600_000 + int(rand, 600_000);
    const status = (['matched', 'adjusted', 'needs_review', 'provider_unavailable'] as const)[
      weighted(rand, [0.75, 0.1, 0.1, 0.05])
    ] as ReconciliationRow['status'];
    const ledgerMicros = int(rand, 50_000_000);
    const providerMicros =
      status === 'provider_unavailable' ? null : ledgerMicros + int(rand, 20_000);
    const drift = providerMicros === null ? 0 : providerMicros - ledgerMicros;
    const adjustId = status === 'adjusted' ? hexId(rand, 'le') : null;
    if (adjustId !== null) {
      ledger.push({
        id: adjustId,
        organization_id: ctx.orgId,
        wallet_id: walletId,
        kind: 'adjust',
        balance_delta_micros: -drift,
        held_delta_micros: 0,
        reservation_id: null,
        ref_type: 'reconciliation',
        ref_id: date,
        idempotency_key: `perf-reconcile-${date}`,
        note: `Reconciliation ${date} (voice)`,
        actor_user_id: null,
        created_at: microIso(createdMs - 1000, 0),
      });
    }
    reports.push({
      id: hexId(rand, 'rc'),
      organization_id: ctx.orgId,
      period_date: date,
      service: 'voice',
      trigger: rand() < 0.9 ? 'cron' : 'manual',
      status,
      captured_micros: ledgerMicros,
      provider_micros: providerMicros,
      ledger_micros: ledgerMicros,
      drift_micros: drift,
      adjust_entry_id: adjustId,
      actor_user_id: null,
      created_at: microIso(createdMs, 0),
    });
  }
  return { reports, ledger };
}

const REF_TYPES = ['call', 'sms', 'whatsapp'] as const;
const REF_PREFIX: Record<string, 'cl' | 'mg'> = { call: 'cl', sms: 'mg', whatsapp: 'mg' };

/**
 * Exactly `total` ledger rows, oldest first: the starter credit, then credits, adjustments and
 * reservations each closed at once by a capture or release, with the `scheduled` rows (order
 * holds, reconciliation adjustments) merged in by time. A reservation always precedes its close.
 */
export function* generateLedger(
  rand: Rand,
  ctx: OrgContext,
  walletId: string,
  total: number,
  scheduled: readonly LedgerRow[],
): Generator<LedgerRow[]> {
  const queue = [...scheduled].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const base = { organization_id: ctx.orgId, wallet_id: walletId };
  const starter: LedgerRow = {
    ...base,
    id: hexId(rand, 'le'),
    kind: 'credit',
    balance_delta_micros: STARTER_CREDIT.micros,
    held_delta_micros: 0,
    reservation_id: null,
    ref_type: null,
    ref_id: null,
    idempotency_key: STARTER_CREDIT.key,
    note: STARTER_CREDIT.note,
    actor_user_id: null,
    created_at: microIso(WINDOW_START_MS - 3_600_000, 0),
  };
  const random = Math.max(0, total - 1 - queue.length);
  const gap = Math.max(2, Math.floor(WINDOW_MS / Math.max(1, random)));
  let clockMs = WINDOW_START_MS;
  let made = 0;
  let q = 0;
  let batch: LedgerRow[] = [starter];
  const emit = function* (row: LedgerRow): Generator<LedgerRow[]> {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      yield batch;
      batch = [];
    }
  };
  const row = (fields: Partial<LedgerRow> & Pick<LedgerRow, 'kind'>): LedgerRow => ({
    ...base,
    id: hexId(rand, 'le'),
    balance_delta_micros: 0,
    held_delta_micros: 0,
    reservation_id: null,
    ref_type: null,
    ref_id: null,
    idempotency_key: `perf-le-${made}`,
    note: null,
    actor_user_id: null,
    created_at: microIso(clockMs, int(rand, 1000)),
    ...fields,
  });
  while (made < random) {
    clockMs += 1 + int(rand, 2 * gap);
    while (q < queue.length && (queue[q] as LedgerRow).created_at <= microIso(clockMs, 999)) {
      yield* emit(queue[q] as LedgerRow);
      q++;
    }
    const r = rand();
    if (r < 0.02 || made === random - 1) {
      made++;
      const amount = (10 + int(rand, 490)) * 1_000_000;
      yield* emit(
        row({
          kind: 'credit',
          balance_delta_micros: amount,
          note: 'Top up',
          actor_user_id: ctx.ownerId,
        }),
      );
    } else if (r < 0.03) {
      made++;
      yield* emit(
        row({
          kind: 'adjust',
          balance_delta_micros: int(rand, 200_000) - 100_000,
          note: 'Manual adjustment',
          actor_user_id: ctx.ownerId,
        }),
      );
    } else {
      const refType = pick(rand, REF_TYPES);
      const refId = hexId(rand, REF_PREFIX[refType] as 'cl' | 'mg');
      const held = 50_000 + int(rand, 450_000);
      made++;
      const reserve = row({
        kind: 'reserve',
        held_delta_micros: held,
        ref_type: refType,
        ref_id: refId,
      });
      yield* emit(reserve);
      clockMs += 1000 + int(rand, 300_000);
      const capture = r < 0.88;
      made++;
      yield* emit(
        row({
          kind: capture ? 'capture' : 'release',
          balance_delta_micros: capture ? -int(rand, held + 1) : 0,
          held_delta_micros: -held,
          reservation_id: reserve.id,
          ref_type: refType,
          ref_id: refId,
        }),
      );
    }
  }
  while (q < queue.length) {
    yield* emit(queue[q] as LedgerRow);
    q++;
  }
  if (batch.length > 0) yield batch;
}

const SERVICES = ['voice', 'sms', 'whatsapp', 'ai'] as const;
const UNITS: Record<string, string> = {
  voice: 'second',
  sms: 'message',
  whatsapp: 'message',
  ai: 'token',
};

export function generateUsageEvents(rand: Rand, ctx: OrgContext, n: number): UsageEventRow[] {
  return Array.from({ length: n }, (_, i) => {
    const service = SERVICES[weighted(rand, [0.5, 0.3, 0.1, 0.1])] as string;
    const at = new Date(msBetween(rand, WINDOW_START_MS, WINDOW_END_MS)).toISOString();
    return {
      id: hexId(rand, 'ue'),
      organization_id: ctx.orgId,
      user_id: ctx.ownerId,
      service,
      quantity: 1 + int(rand, 600),
      unit: UNITS[service] as string,
      cost_micros: int(rand, 100_000),
      provider: 'fake',
      idempotency_key: `perf-usage-${i}`,
      occurred_at: at,
      created_at: at,
    };
  });
}

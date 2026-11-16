import type { components } from '@knoqra/api-client';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api, throwIfFailed } from './api';
import { spendNoteCopy } from './calls';
import type { LedgerFilters } from './ledger-csv';
import { walletKey } from './wallet';

export type UsageBalance = components['schemas']['UsageBalance'];
export type UsageSummary = components['schemas']['UsageSummary'];
export type UsageLedgerRow = components['schemas']['UsageLedgerRow'];
export type ReconciliationReport = components['schemas']['ReconciliationReport'];
export type ProviderSnapshot = components['schemas']['ProviderSnapshot'];
export type SpendDecision = components['schemas']['SpendDecision'];
export type { LedgerFilters };

import { USAGE_CHANNELS, type UsageChannel } from './usage-channels';

export { USAGE_CHANNELS, type UsageChannel };

export const CHANNEL_LABELS: Record<UsageChannel, string> = {
  voice: 'Voice',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  other: 'Other',
};

export const KIND_LABELS: Record<UsageLedgerRow['kind'], string> = {
  credit: 'Credit',
  adjust: 'Adjustment',
  reserve: 'Hold',
  capture: 'Capture',
  release: 'Release',
  fee: 'Platform fee',
};

export const usageRoot = ['usage'] as const;
export const usageBalanceKey = [...usageRoot, 'balance'] as const;
export const usageSummaryKey = (from: string, to: string) =>
  [...usageRoot, 'summary', from, to] as const;
export const usageLedgerKey = (filters: LedgerFilters) =>
  [...usageRoot, 'ledger', filters] as const;
export const reconciliationsKey = [...usageRoot, 'reconciliations'] as const;

/** The ledger filters as the /usage URL carries them; a missing key means the default. */
export interface UsageSearch {
  from?: string;
  to?: string;
  channel?: string;
  kind?: string;
}

interface DateRange {
  from: string;
  to: string;
}

export function filtersFromSearch(search: UsageSearch, fallback: DateRange): LedgerFilters {
  return {
    from: search.from ?? fallback.from,
    to: search.to ?? fallback.to,
    channel: (search.channel ?? 'all') as LedgerFilters['channel'],
    kind: (search.kind ?? 'all') as LedgerFilters['kind'],
  };
}

/**
 * The next /usage search: the patch applied to the router's latest search, never to the filters of
 * an older render, so two quick filter changes do not undo each other. Defaults are left out.
 */
export function patchUsageSearch(
  latest: UsageSearch,
  patch: Partial<LedgerFilters>,
  fallback: DateRange,
): UsageSearch {
  const next = { ...filtersFromSearch(latest, fallback), ...patch };
  return {
    ...(next.from !== fallback.from ? { from: next.from } : {}),
    ...(next.to !== fallback.to ? { to: next.to } : {}),
    ...(next.channel !== 'all' ? { channel: next.channel } : {}),
    ...(next.kind !== 'all' ? { kind: next.kind } : {}),
  };
}

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The first of the UTC month to today (UTC). */
export function defaultRange(now: Date): { from: string; to: string } {
  const to = isoDate(now);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** Yesterday in UTC, the default day to reconcile. */
export function yesterday(now: Date): string {
  return isoDate(new Date(now.getTime() - DAY_MS));
}

function parseDay(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || isoDate(new Date(time)) !== value ? null : time;
}

/** The API's rules for a date range, with copy for the filter row. Null when it is fine. */
export function validateRange(from: string, to: string): string | null {
  const start = parseDay(from);
  const end = parseDay(to);
  if (start === null || end === null) return 'Choose a start and end date.';
  if (start > end) return 'Start date must be on or before the end date.';
  if ((end - start) / DAY_MS + 1 > MAX_RANGE_DAYS) return 'Choose a range of a year or less.';
  return null;
}

const RECONCILIATION_LABELS: Record<ReconciliationReport['status'], string> = {
  matched: 'Matched',
  adjusted: 'Adjusted',
  needs_review: 'Needs review',
  provider_unavailable: 'Provider unavailable',
};

export function reconciliationStatusLabel(status: ReconciliationReport['status']): string {
  return RECONCILIATION_LABELS[status];
}

const PROVIDER_STATUS_COPY = {
  ok: 'Connected',
  auth_failed: 'Your phone provider rejected the key',
  unavailable: 'Phone provider unavailable',
} as const satisfies Record<NonNullable<ProviderSnapshot>['status'], string>;

export function providerStatusCopy(status: NonNullable<ProviderSnapshot>['status']): string {
  return PROVIDER_STATUS_COPY[status];
}

/** The spend banner's text: the dialer's wording, so both places say the same thing. */
export function spendBannerCopy(spend: SpendDecision): string | null {
  return spendNoteCopy(spend.outcome, spend.reason);
}

// --- Queries ----------------------------------------------------------------------------------

export function useUsageBalance() {
  return useQuery({
    queryKey: usageBalanceKey,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/usage/balance', { signal }),
        'Could not load your balances.',
      ),
  });
}

export function useRefreshBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<UsageBalance> =>
      throwIfFailed(
        await api.POST('/api/v1/usage/balance/refresh'),
        'Could not refresh the provider balance.',
      ),
    onSuccess: (balance) => {
      queryClient.setQueryData(usageBalanceKey, balance);
    },
  });
}

export function useUsageSummary(range: { from: string; to: string }, enabled = true) {
  return useQuery({
    queryKey: usageSummaryKey(range.from, range.to),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/usage/summary', { params: { query: range }, signal }),
        'Could not load your spend.',
      ),
  });
}

/** One ledger page; the table pages through it and the export walks every page. */
export const fetchLedgerPage = async (
  filters: LedgerFilters,
  cursor: string | undefined,
  limit: number,
  signal?: AbortSignal,
): Promise<components['schemas']['UsageLedgerPage']> =>
  throwIfFailed(
    await api.GET('/api/v1/usage/ledger', {
      params: {
        query: {
          from: filters.from,
          to: filters.to,
          channel: filters.channel,
          kind: filters.kind,
          limit,
          ...(cursor ? { cursor } : {}),
        },
      },
      ...(signal ? { signal } : {}),
    }),
    'Could not load the ledger.',
  );

const LEDGER_PAGE_SIZE = 50;

export function useUsageLedger(filters: LedgerFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: usageLedgerKey(filters),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchLedgerPage(filters, pageParam, LEDGER_PAGE_SIZE, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useReconciliations() {
  return useInfiniteQuery({
    queryKey: reconciliationsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      throwIfFailed(
        await api.GET('/api/v1/usage/reconciliations', {
          params: { query: pageParam ? { cursor: pageParam } : {} },
          signal,
        }),
        'Could not load reconciliations.',
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (date: string): Promise<ReconciliationReport> =>
      throwIfFailed(
        await api.POST('/api/v1/usage/reconciliations', { body: { date } }),
        'Could not run the reconciliation.',
      ),
    onSuccess: () => {
      // An adjustment moves the balance, the ledger and the spend totals.
      void queryClient.invalidateQueries({ queryKey: usageRoot });
      void queryClient.invalidateQueries({ queryKey: walletKey });
    },
  });
}

// --- Display helpers --------------------------------------------------------------------------

/** "just now", "5 min ago", "3 h ago", "2 d ago": how long before `now` a snapshot was taken. */
export function relativeAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export interface ChannelTotal {
  channel: UsageChannel;
  micros: number;
}

export function channelTotals(totals: UsageSummary['totals']): ChannelTotal[] {
  return USAGE_CHANNELS.map((channel) => ({ channel, micros: totals[channel] }));
}

/** One day's four channel amounts and their sum. */
export function dayTotal(day: UsageSummary['days'][number]): number {
  return day.voice + day.sms + day.whatsapp + day.other;
}

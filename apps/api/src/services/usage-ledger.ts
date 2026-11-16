import type { LedgerKind } from '@knoqra/core';
import { ledgerEntry, type Tx } from '@knoqra/db';
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';
import type {
  UsageLedgerQuery,
  UsageLedgerRowJson,
  UsageSummaryDayJson,
  UsageSummaryJson,
} from '../lib/m4-schemas';

export const USAGE_CHANNELS = ['voice', 'sms', 'whatsapp', 'other'] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];

/** ref_type values that name a channel; everything else is `other` (Ruling R10). */
const CHANNEL_BY_REF: Readonly<Record<string, UsageChannel>> = {
  call: 'voice',
  sms: 'sms',
  whatsapp: 'whatsapp',
};

export function channelOfRef(refType: string | null): UsageChannel {
  return (refType !== null && CHANNEL_BY_REF[refType]) || 'other';
}

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;

/** A real `YYYY-MM-DD` calendar day as UTC midnight, or null (2026-02-30 is not a day). */
export function parseUtcDay(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

export type RangeCheck =
  | { ok: true; start: Date; endExclusive: Date; days: number }
  | { ok: false; message: string };

/** Validates an inclusive UTC day range (`from <= to`, at most 366 days). */
export function checkRange(from: string, to: string): RangeCheck {
  const start = parseUtcDay(from);
  const end = parseUtcDay(to);
  if (!start || !end) return { ok: false, message: 'Dates must be real YYYY-MM-DD days.' };
  if (start > end) return { ok: false, message: 'The start date must not be after the end date.' };
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    return { ok: false, message: `The range must not exceed ${MAX_RANGE_DAYS} days.` };
  }
  return { ok: true, start, endExclusive: new Date(end.getTime() + DAY_MS), days };
}

const channelCase = (refType: SQL | SQL.Aliased | unknown) =>
  sql<UsageChannel>`case ${refType} when 'call' then 'voice' when 'sms' then 'sms' when 'whatsapp' then 'whatsapp' else 'other' end`;

export async function usageSummary(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
  range: { start: Date; endExclusive: Date; days: number },
  platformFeeMicrosPerMinute = 0,
): Promise<UsageSummaryJson> {
  const rows = await tx
    .select({
      day: sql<string>`to_char(${ledgerEntry.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      kind: ledgerEntry.kind,
      channel: channelCase(ledgerEntry.refType),
      total: sql<string>`sum(${ledgerEntry.balanceDeltaMicros})::bigint`,
    })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.organizationId, orgId),
        gte(ledgerEntry.createdAt, range.start),
        lt(ledgerEntry.createdAt, range.endExclusive),
        inArray(ledgerEntry.kind, ['capture', 'adjust', 'credit', 'fee']),
      ),
    )
    .groupBy(sql`1, 2, 3`);

  const days = new Map<string, UsageSummaryDayJson>();
  for (let i = 0; i < range.days; i += 1) {
    const date = new Date(range.start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    days.set(date, { date, voice: 0, sms: 0, whatsapp: 0, other: 0, platformFee: 0 });
  }
  const totals = {
    voice: 0,
    sms: 0,
    whatsapp: 0,
    other: 0,
    adjustments: 0,
    credits: 0,
    platformFees: 0,
  };
  for (const row of rows) {
    const total = Number(row.total);
    if (row.kind === 'fee') {
      const fee = -total;
      const entry = days.get(row.day);
      if (entry) days.set(row.day, { ...entry, platformFee: entry.platformFee + fee });
      totals.platformFees += fee;
    } else if (row.kind === 'capture') {
      const spend = -total;
      const entry = days.get(row.day);
      if (entry) days.set(row.day, { ...entry, [row.channel]: entry[row.channel] + spend });
      totals[row.channel] += spend;
    } else if (row.kind === 'adjust') {
      totals.adjustments += total;
    } else {
      totals.credits += total;
    }
  }
  return { from, to, days: [...days.values()], totals, platformFeeMicrosPerMinute };
}

const KIND_DESCRIPTION: Partial<Record<LedgerKind, string>> = {
  reserve: 'Hold for call',
  capture: 'Call charge',
  release: 'Hold released',
  fee: 'Platform fee',
};

/** Labels for a ref type that is not a channel of its own (its channel stays `other`). */
const REF_DESCRIPTION: Readonly<Record<string, Partial<Record<LedgerKind, string>>>> = {
  number_order: {
    reserve: 'Hold for number',
    capture: 'Number charge',
    release: 'Hold released',
  },
};

export function describeEntry(
  kind: LedgerKind,
  channel: UsageChannel,
  note: string | null,
  refType: string | null = null,
): string {
  if (kind === 'credit') return note ?? 'Credit';
  if (kind === 'adjust') return note ?? 'Adjustment';
  if (kind === 'fee') return 'Platform fee';
  const byRef = refType === null ? undefined : REF_DESCRIPTION[refType]?.[kind];
  if (byRef) return byRef;
  if (channel !== 'voice') return channel;
  return KIND_DESCRIPTION[kind] ?? kind;
}

/** Microsecond-precision ISO text, so a keyset cursor never rounds a row away. */
const createdKeyOf = (column: unknown) =>
  sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface LedgerCursor {
  occurredAt: string;
  id: string;
}

export interface LedgerFilter {
  query: Pick<UsageLedgerQuery, 'channel' | 'kind' | 'limit'>;
  start: Date | null;
  endExclusive: Date | null;
  cursor: LedgerCursor | undefined;
}

export interface LedgerPageResult {
  items: UsageLedgerRowJson[];
  last: LedgerCursor | null;
  hasMore: boolean;
}

/**
 * Running sums use a window over every entry of the org ordered (created_at, id), so a filter
 * never changes a row's balance; filters and the keyset page apply on top of that.
 */
export async function usageLedgerPage(
  tx: Tx,
  orgId: string,
  filter: LedgerFilter,
): Promise<LedgerPageResult> {
  const { query, start, endExclusive, cursor } = filter;
  const windowOrder = sql`partition by ${ledgerEntry.organizationId} order by ${ledgerEntry.createdAt}, ${ledgerEntry.id}`;
  const l = tx
    .select({
      id: ledgerEntry.id,
      createdAt: ledgerEntry.createdAt,
      kind: ledgerEntry.kind,
      refType: ledgerEntry.refType,
      refId: ledgerEntry.refId,
      note: ledgerEntry.note,
      balanceDelta: ledgerEntry.balanceDeltaMicros,
      heldDelta: ledgerEntry.heldDeltaMicros,
      balanceAfter:
        sql<string>`(sum(${ledgerEntry.balanceDeltaMicros}) over (${windowOrder}))::bigint`.as(
          'balance_after',
        ),
      heldAfter:
        sql<string>`(sum(${ledgerEntry.heldDeltaMicros}) over (${windowOrder}))::bigint`.as(
          'held_after',
        ),
    })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.organizationId, orgId))
    .as('l');

  const channel = channelCase(l.refType);
  const rows = await tx
    .select({
      id: l.id,
      createdAt: l.createdAt,
      key: createdKeyOf(l.createdAt),
      kind: l.kind,
      channel,
      refType: l.refType,
      refId: l.refId,
      note: l.note,
      balanceDelta: l.balanceDelta,
      heldDelta: l.heldDelta,
      balanceAfter: l.balanceAfter,
      heldAfter: l.heldAfter,
    })
    .from(l)
    .where(
      and(
        start ? gte(l.createdAt, start) : undefined,
        endExclusive ? lt(l.createdAt, endExclusive) : undefined,
        query.kind === 'all' ? undefined : eq(l.kind, query.kind),
        query.channel === 'all' ? undefined : sql`${channel} = ${query.channel}`,
        cursor
          ? sql`(${l.createdAt}, ${l.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(l.createdAt), desc(l.id))
    .limit(query.limit + 1);

  const page = rows.slice(0, query.limit);
  const items = page.map((r): UsageLedgerRowJson => {
    const balanceAfterMicros = Number(r.balanceAfter);
    const heldAfterMicros = Number(r.heldAfter);
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      kind: r.kind,
      channel: r.channel,
      description: describeEntry(r.kind, r.channel, r.note, r.refType),
      balanceDeltaMicros: Number(r.balanceDelta),
      heldDeltaMicros: Number(r.heldDelta),
      balanceAfterMicros,
      heldAfterMicros,
      availableAfterMicros: balanceAfterMicros - heldAfterMicros,
      refType: r.refType,
      refId: r.refId,
      note: r.note,
    };
  });
  const lastRow = page.at(-1);
  return {
    items,
    last: lastRow ? { occurredAt: lastRow.key, id: lastRow.id } : null,
    hasMore: rows.length > query.limit,
  };
}

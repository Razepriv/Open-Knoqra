import { z } from '@hono/zod-openapi';
import { LEDGER_KINDS, SETUP_CHECK_IDS, SETUP_STEPS } from '@knoqra/core';
import { SpendDecisionSchema, WalletSummarySchema } from '../routes/wallet';

/**
 * Shared HTTP contract for M4 (setup, usage balance, reconciliation, usage summary and ledger).
 * Money is integer micros, dates are `YYYY-MM-DD` UTC days, timestamps are ISO strings.
 */

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DateStringSchema = z.string().regex(DATE_PATTERN, 'Expected YYYY-MM-DD');
const Micros = z.number().int();

export const USAGE_CHANNEL_NAMES = ['voice', 'sms', 'whatsapp', 'other'] as const;
export const RECONCILE_STATUS_NAMES = [
  'matched',
  'adjusted',
  'needs_review',
  'provider_unavailable',
] as const;

const SetupStepEnum = z.enum(SETUP_STEPS);

const SetupFixSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wizard'), step: SetupStepEnum }),
  z.object({ kind: z.literal('external'), href: z.string(), label: z.string() }),
]);

export const SetupCheckSchema = z
  .object({
    id: z.enum(SETUP_CHECK_IDS),
    status: z.enum(['pass', 'fail', 'pending']),
    title: z.string(),
    detail: z.string(),
    fix: SetupFixSchema.nullable(),
  })
  .openapi('SetupCheck');
export type SetupCheckJson = z.infer<typeof SetupCheckSchema>;

export const SetupStepStateSchema = z
  .object({ id: SetupStepEnum, done: z.boolean() })
  .openapi('SetupStepState');
export type SetupStepStateJson = z.infer<typeof SetupStepStateSchema>;

export const SetupSchema = z
  .object({
    steps: z.array(SetupStepStateSchema),
    currentStep: SetupStepEnum.nullable(),
    lastStep: SetupStepEnum.nullable(),
    dismissedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    checks: z.array(SetupCheckSchema),
  })
  .openapi('Setup');
export type SetupJson = z.infer<typeof SetupSchema>;

export const UpdateSetupSchema = z
  .object({
    lastStep: SetupStepEnum.optional(),
    audioChecked: z.literal(true).optional(),
    testCallId: z.string().min(1).max(64).optional(),
    dismissed: z.boolean().optional(),
  })
  .openapi('UpdateSetup');
export type UpdateSetupBody = z.infer<typeof UpdateSetupSchema>;

export const ProviderSnapshotSchema = z
  .object({
    status: z.enum(['ok', 'auth_failed', 'unavailable']),
    balanceMicros: Micros.nullable(),
    capturedAt: z.iso.datetime(),
  })
  .openapi('ProviderSnapshot');
export type ProviderSnapshotJson = z.infer<typeof ProviderSnapshotSchema>;

export const UsageBalanceSchema = z
  .object({
    wallet: WalletSummarySchema,
    provider: ProviderSnapshotSchema.nullable(),
    spend: SpendDecisionSchema,
  })
  .openapi('UsageBalance');
export type UsageBalanceJson = z.infer<typeof UsageBalanceSchema>;

export const ReconciliationReportSchema = z
  .object({
    id: z.string(),
    date: DateStringSchema,
    service: z.enum(['voice']),
    trigger: z.enum(['cron', 'manual']),
    status: z.enum(RECONCILE_STATUS_NAMES),
    capturedMicros: Micros,
    providerMicros: Micros.nullable(),
    ledgerMicros: Micros,
    driftMicros: Micros,
    adjustEntryId: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('ReconciliationReport');
export type ReconciliationJson = z.infer<typeof ReconciliationReportSchema>;

export const ReconciliationPageSchema = z
  .object({ items: z.array(ReconciliationReportSchema), nextCursor: z.string().nullable() })
  .openapi('ReconciliationPage');
export type ReconciliationPageJson = z.infer<typeof ReconciliationPageSchema>;

export const RunReconciliationSchema = z
  .object({ date: DateStringSchema })
  .openapi('RunReconciliation');
export type RunReconciliationBody = z.infer<typeof RunReconciliationSchema>;

export const UsageSummaryDaySchema = z
  .object({
    date: DateStringSchema,
    voice: Micros,
    sms: Micros,
    whatsapp: Micros,
    other: Micros,
    /** KNOQRA's platform fee on calls that day (not part of `voice`). */
    platformFee: Micros,
  })
  .openapi('UsageSummaryDay');
export type UsageSummaryDayJson = z.infer<typeof UsageSummaryDaySchema>;

export const UsageSummarySchema = z
  .object({
    from: DateStringSchema,
    to: DateStringSchema,
    days: z.array(UsageSummaryDaySchema),
    totals: z.object({
      voice: Micros,
      sms: Micros,
      whatsapp: Micros,
      other: Micros,
      adjustments: Micros,
      credits: Micros,
      platformFees: Micros,
    }),
    /** The platform fee per billed call minute now in force (0: no fee). */
    platformFeeMicrosPerMinute: Micros,
  })
  .openapi('UsageSummary');
export type UsageSummaryJson = z.infer<typeof UsageSummarySchema>;

export const UsageLedgerRowSchema = z
  .object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    kind: z.enum(LEDGER_KINDS),
    channel: z.enum(USAGE_CHANNEL_NAMES),
    description: z.string(),
    balanceDeltaMicros: Micros,
    heldDeltaMicros: Micros,
    balanceAfterMicros: Micros,
    heldAfterMicros: Micros,
    availableAfterMicros: Micros,
    refType: z.string().nullable(),
    refId: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi('UsageLedgerRow');
export type UsageLedgerRowJson = z.infer<typeof UsageLedgerRowSchema>;

export const UsageLedgerPageSchema = z
  .object({ items: z.array(UsageLedgerRowSchema), nextCursor: z.string().nullable() })
  .openapi('UsageLedgerPage');
export type UsageLedgerPageJson = z.infer<typeof UsageLedgerPageSchema>;

const cursor = z.string().max(MAX_CURSOR_LENGTH).optional();
const limit = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

export const UsageRangeQuerySchema = z.object({ from: DateStringSchema, to: DateStringSchema });
export type UsageRangeQuery = z.infer<typeof UsageRangeQuerySchema>;

export const UsageLedgerQuerySchema = z.object({
  from: DateStringSchema.optional(),
  to: DateStringSchema.optional(),
  channel: z.enum(['all', ...USAGE_CHANNEL_NAMES]).default('all'),
  kind: z.enum(['all', ...LEDGER_KINDS]).default('all'),
  limit,
  cursor,
});
export type UsageLedgerQuery = z.infer<typeof UsageLedgerQuerySchema>;

export const PageQuerySchema = z.object({ limit, cursor });
export type PageQuery = z.infer<typeof PageQuerySchema>;

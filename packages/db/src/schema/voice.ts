import {
  CALL_CUTOFF_REASONS,
  CALL_OUTCOMES,
  CALL_STATES,
  newId,
  TERMINAL_CALL_STATES,
} from '@knoqra/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { organization } from './auth';
import { createdAt } from './columns';
import { ledgerEntry } from './ledger';

const terminalStates = sql.raw(TERMINAL_CALL_STATES.map((s) => `'${s}'`).join(', '));

/**
 * A voice call. Tenant-owned: forced RLS (sql/rls.sql). contact_id is a composite FK to contact
 * ON DELETE SET NULL (contact_id): raw SQL in migration 0004 (Drizzle cannot express the PG15+
 * column-list form), so no FK is declared on that column here.
 */
export const call = pgTable(
  'call',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('cl')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    contactId: text('contact_id'),
    direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
    state: text('state', { enum: CALL_STATES }).notNull(),
    fromE164: text('from_e164').notNull(),
    toE164: text('to_e164').notNull(),
    provider: text('provider').notNull(),
    providerCallId: text('provider_call_id'),
    clientState: text('client_state').notNull().unique(),
    idempotencyKey: text('idempotency_key'),
    reservationId: text('reservation_id'),
    /** What the call was charged: billed minutes at `price_micros_per_minute`. */
    costMicros: bigint('cost_micros', { mode: 'number' }),
    /**
     * KNOQRA's price per minute to this destination, fixed when the call is authorized. Null for
     * calls priced at the flat voice rate (inbound calls, and calls from before per-destination
     * pricing).
     */
    priceMicrosPerMinute: bigint('price_micros_per_minute', { mode: 'number' }),
    /** The provider's estimated all-in cost per minute to this destination, for reconciliation. */
    providerCostMicrosPerMinute: bigint('provider_cost_micros_per_minute', { mode: 'number' }),
    /** The provider's estimated cost of the call: billed minutes at the cost per minute. */
    providerCostMicros: bigint('provider_cost_micros', { mode: 'number' }),
    /** The rate table's country (ISO 3166-1 alpha-2) and number type the call was priced as. */
    rateCountry: text('rate_country'),
    rateNumberType: text('rate_number_type'),
    reviewConfirmed: boolean('review_confirmed').notNull().default(false),
    outcome: text('outcome', { enum: CALL_OUTCOMES }),
    outcomeNote: text('outcome_note'),
    outcomeAt: timestamp('outcome_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    hangupCause: text('hangup_cause'),
    billableSeconds: integer('billable_seconds'),
    /**
     * Billed minutes from the answer that the call's holds cover: the 10 held at the start plus
     * every block held mid-call (services/call-meter.ts). Null while the call holds nothing.
     */
    paidMinutes: integer('paid_minutes'),
    /**
     * Set when a mid-call extension was refused (no credit, or the monthly stop cap) or the call ran
     * past its paid minutes: why, and when the call is (or was) ended. Cleared if a later extension
     * succeeds.
     */
    cutoffReason: text('cutoff_reason', { enum: CALL_CUTOFF_REASONS }),
    cutoffAt: timestamp('cutoff_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('call_organization_id_id_unique').on(table.organizationId, table.id),
    unique('call_organization_id_user_id_idempotency_key_unique').on(
      table.organizationId,
      table.userId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: 'call_reservation_fk',
      columns: [table.organizationId, table.reservationId],
      foreignColumns: [ledgerEntry.organizationId, ledgerEntry.id],
    }),
    check('call_direction_check', sql`${table.direction} in ('outbound', 'inbound')`),
    check(
      'call_state_check',
      sql`${table.state} in ('queued', 'initiating', 'ringing', 'connected', 'ending', 'completed', 'failed', 'busy', 'no_answer', 'canceled')`,
    ),
    check(
      'call_outcome_check',
      sql`${table.outcome} is null or ${table.outcome} in ('connected', 'rescheduled', 'follow_up', 'voicemail', 'no_answer', 'wrong_number')`,
    ),
    check('call_organization_id_not_empty', sql`${table.organizationId} <> ''`),
    check(
      'call_paid_minutes_positive',
      sql`${table.paidMinutes} is null or ${table.paidMinutes} > 0`,
    ),
    check(
      'call_cutoff_reason_check',
      sql`${table.cutoffReason} is null or ${table.cutoffReason} in ('insufficient_funds', 'stop_cap', 'paid_time_over')`,
    ),
    index('call_org_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('call_contact_created_idx').on(table.contactId, table.createdAt.desc().nullsFirst()),
    // `/calls/active` (M6c): only live calls, newest first per user. Without it the poll walks the
    // org's whole call history backwards when the user has no live call, the common case. The
    // predicate repeats the route's notInArray(TERMINAL_CALL_STATES) so the planner can prove it.
    index('call_live_user_idx')
      .on(
        table.organizationId,
        table.userId,
        table.createdAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
      )
      .where(sql`state not in (${terminalStates})`),
  ],
);

/** Append-only call signal log; one row per (call, raw provider event). */
export const callEvent = pgTable(
  'call_event',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('ce')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    rawEventId: text('raw_event_id').notNull(),
    signal: text('signal').notNull(),
    stateBefore: text('state_before'),
    stateAfter: text('state_after'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'call_event_call_fk',
      columns: [table.organizationId, table.callId],
      foreignColumns: [call.organizationId, call.id],
    }).onDelete('cascade'),
    unique('call_event_call_id_raw_event_id_unique').on(table.callId, table.rawEventId),
    check('call_event_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

/**
 * Voicemail left on a call. The only allowed update is listened_at (sql/rls.sql).
 * contact_id: composite FK ON DELETE SET NULL (contact_id) is raw SQL in migration 0004.
 */
export const voicemail = pgTable(
  'voicemail',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId('vm')),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    callId: text('call_id').notNull(),
    contactId: text('contact_id'),
    fromE164: text('from_e164').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    transcript: text('transcript'),
    recordingKey: text('recording_key'),
    listenedAt: timestamp('listened_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'voicemail_call_fk',
      columns: [table.organizationId, table.callId],
      foreignColumns: [call.organizationId, call.id],
    }).onDelete('cascade'),
    unique('voicemail_call_id_unique').on(table.callId),
    // The voicemail list (M6c): newest first, matching its ORDER BY created_at desc, id desc.
    index('voicemail_org_created_idx').on(
      table.organizationId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    check('voicemail_organization_id_not_empty', sql`${table.organizationId} <> ''`),
  ],
);

export type CallRow = typeof call.$inferSelect;
export type NewCall = typeof call.$inferInsert;
export type CallEventRow = typeof callEvent.$inferSelect;
export type NewCallEvent = typeof callEvent.$inferInsert;
export type VoicemailRow = typeof voicemail.$inferSelect;
export type NewVoicemail = typeof voicemail.$inferInsert;

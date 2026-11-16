import { index, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';
import { createdAt } from './columns';

/**
 * System table, deliberately NOT under row-level security: resolves an inbound provider webhook
 * (by client_state or provider call id) to its organization before any tenant is known.
 * Never expose it through tenant queries.
 */
export const callRoute = pgTable(
  'call_route',
  {
    clientState: text('client_state').primaryKey(),
    organizationId: text('organization_id').notNull(),
    callId: text('call_id').notNull(),
    provider: text('provider').notNull(),
    providerCallId: text('provider_call_id'),
    createdAt: createdAt(),
  },
  (table) => [
    unique('call_route_provider_provider_call_id_unique').on(table.provider, table.providerCallId),
    index('call_route_call_idx').on(table.callId),
  ],
);

/**
 * System table, NOT under row-level security: maps a provider-owned phone number to the
 * organization that owns it, for inbound calls. Never expose it through tenant queries.
 */
export const providerNumberRoute = pgTable(
  'provider_number_route',
  {
    provider: text('provider').notNull(),
    e164: text('e164').notNull(),
    organizationId: text('organization_id').notNull(),
  },
  (table) => [
    primaryKey({ name: 'provider_number_route_pk', columns: [table.provider, table.e164] }),
  ],
);

export type CallRoute = typeof callRoute.$inferSelect;
export type ProviderNumberRoute = typeof providerNumberRoute.$inferSelect;

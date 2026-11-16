-- Connectors: a workspace connects one telephony provider (Telnyx or Plivo). provider_credential
-- moves its unique key from (organization_id, provider) to organization_id, which existing data
-- already satisfies (only 'telnyx' was allowed), and gains the Plivo Auth ID (account_id) and the
-- Telnyx account's webhook public key. Numbers, quotes and orders accept 'plivo'.
-- provider_event_raw.organization_id marks a delivery verified with one workspace's own key, so the
-- handlers can refuse to apply it to any other workspace. ledger_entry gains the 'fee' kind for the
-- per-minute platform fee: a plain debit, outside any reservation.
-- Per-destination call pricing: call gains its price and estimated provider cost per minute, the
-- estimated provider cost of the call, and the country and number type it was priced as. All are
-- nullable: older calls keep the flat voice rate.
-- Another branch (payments) also changes the ledger_entry checks: merge both kind lists by hand and
-- expect this file to be renumbered at merge.
ALTER TABLE "provider_credential" DROP CONSTRAINT "provider_credential_organization_id_provider_unique";--> statement-breakpoint
ALTER TABLE "provider_credential" DROP CONSTRAINT "provider_credential_provider_check";--> statement-breakpoint
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_kind_check";--> statement-breakpoint
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_kind_signs";--> statement-breakpoint
ALTER TABLE "number_order" DROP CONSTRAINT "number_order_provider_check";--> statement-breakpoint
ALTER TABLE "number_quote" DROP CONSTRAINT "number_quote_provider_check";--> statement-breakpoint
ALTER TABLE "phone_number" DROP CONSTRAINT "phone_number_provider_check";--> statement-breakpoint
ALTER TABLE "provider_credential" ADD COLUMN "account_id" text;--> statement-breakpoint
ALTER TABLE "provider_credential" ADD COLUMN "webhook_public_key" text;--> statement-breakpoint
ALTER TABLE "provider_event_raw" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "price_micros_per_minute" bigint;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "provider_cost_micros_per_minute" bigint;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "provider_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "rate_country" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "rate_number_type" text;--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_organization_id_unique" UNIQUE("organization_id");--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_provider_check" CHECK ("provider_credential"."provider" in ('telnyx', 'plivo'));--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_kind_check" CHECK ("ledger_entry"."kind" in ('credit', 'adjust', 'reserve', 'capture', 'release', 'fee'));--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_kind_signs" CHECK (("ledger_entry"."kind" = 'reserve' and "ledger_entry"."balance_delta_micros" = 0 and "ledger_entry"."held_delta_micros" > 0 and "ledger_entry"."reservation_id" is null)
        or ("ledger_entry"."kind" = 'capture' and "ledger_entry"."balance_delta_micros" <= 0 and "ledger_entry"."held_delta_micros" < 0 and "ledger_entry"."reservation_id" is not null)
        or ("ledger_entry"."kind" = 'release' and "ledger_entry"."balance_delta_micros" = 0 and "ledger_entry"."held_delta_micros" < 0 and "ledger_entry"."reservation_id" is not null)
        or ("ledger_entry"."kind" = 'credit' and "ledger_entry"."balance_delta_micros" > 0 and "ledger_entry"."held_delta_micros" = 0)
        or ("ledger_entry"."kind" = 'adjust' and "ledger_entry"."held_delta_micros" = 0)
        or ("ledger_entry"."kind" = 'fee' and "ledger_entry"."balance_delta_micros" < 0 and "ledger_entry"."held_delta_micros" = 0 and "ledger_entry"."reservation_id" is null));--> statement-breakpoint
ALTER TABLE "number_order" ADD CONSTRAINT "number_order_provider_check" CHECK ("number_order"."provider" in ('fake', 'telnyx', 'plivo'));--> statement-breakpoint
ALTER TABLE "number_quote" ADD CONSTRAINT "number_quote_provider_check" CHECK ("number_quote"."provider" in ('fake', 'telnyx', 'plivo'));--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_provider_check" CHECK ("phone_number"."provider" in ('fake', 'telnyx', 'plivo'));

CREATE TABLE "provider_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_iv" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"dek_iv" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"api_key_last4" text NOT NULL,
	"connection_id" text,
	"telephony_credential_id" text,
	"caller_id_e164" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credential_organization_id_provider_unique" UNIQUE("organization_id","provider"),
	CONSTRAINT "provider_credential_provider_check" CHECK ("provider_credential"."provider" in ('telnyx')),
	CONSTRAINT "provider_credential_organization_id_not_empty" CHECK ("provider_credential"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"kind" text NOT NULL,
	"balance_delta_micros" bigint NOT NULL,
	"held_delta_micros" bigint NOT NULL,
	"reservation_id" text,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text NOT NULL,
	"note" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "ledger_entry_organization_id_idempotency_key_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "ledger_entry_kind_check" CHECK ("ledger_entry"."kind" in ('credit', 'adjust', 'reserve', 'capture', 'release')),
	CONSTRAINT "ledger_entry_kind_signs" CHECK (("ledger_entry"."kind" = 'reserve' and "ledger_entry"."balance_delta_micros" = 0 and "ledger_entry"."held_delta_micros" > 0 and "ledger_entry"."reservation_id" is null)
        or ("ledger_entry"."kind" = 'capture' and "ledger_entry"."balance_delta_micros" <= 0 and "ledger_entry"."held_delta_micros" < 0 and "ledger_entry"."reservation_id" is not null)
        or ("ledger_entry"."kind" = 'release' and "ledger_entry"."balance_delta_micros" = 0 and "ledger_entry"."held_delta_micros" < 0 and "ledger_entry"."reservation_id" is not null)
        or ("ledger_entry"."kind" = 'credit' and "ledger_entry"."balance_delta_micros" > 0 and "ledger_entry"."held_delta_micros" = 0)
        or ("ledger_entry"."kind" = 'adjust' and "ledger_entry"."held_delta_micros" = 0)),
	CONSTRAINT "ledger_entry_organization_id_not_empty" CHECK ("ledger_entry"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"warn_cap_micros" bigint,
	"stop_cap_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "wallet_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "wallet_currency_check" CHECK ("wallet"."currency" in ('USD')),
	CONSTRAINT "wallet_caps_ordered" CHECK ("wallet"."warn_cap_micros" is null or "wallet"."stop_cap_micros" is null or "wallet"."warn_cap_micros" <= "wallet"."stop_cap_micros"),
	CONSTRAINT "wallet_organization_id_not_empty" CHECK ("wallet"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "call_route" (
	"client_state" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"call_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_route_provider_provider_call_id_unique" UNIQUE("provider","provider_call_id")
);
--> statement-breakpoint
CREATE TABLE "provider_number_route" (
	"provider" text NOT NULL,
	"e164" text NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "provider_number_route_pk" PRIMARY KEY("provider","e164")
);
--> statement-breakpoint
CREATE TABLE "call" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"contact_id" text,
	"direction" text NOT NULL,
	"state" text NOT NULL,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"provider" text NOT NULL,
	"provider_call_id" text,
	"client_state" text NOT NULL,
	"idempotency_key" text,
	"reservation_id" text,
	"cost_micros" bigint,
	"review_confirmed" boolean DEFAULT false NOT NULL,
	"outcome" text,
	"outcome_note" text,
	"outcome_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"hangup_cause" text,
	"billable_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_client_state_unique" UNIQUE("client_state"),
	CONSTRAINT "call_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "call_organization_id_user_id_idempotency_key_unique" UNIQUE("organization_id","user_id","idempotency_key"),
	CONSTRAINT "call_direction_check" CHECK ("call"."direction" in ('outbound', 'inbound')),
	CONSTRAINT "call_state_check" CHECK ("call"."state" in ('queued', 'initiating', 'ringing', 'connected', 'ending', 'completed', 'failed', 'busy', 'no_answer', 'canceled')),
	CONSTRAINT "call_outcome_check" CHECK ("call"."outcome" is null or "call"."outcome" in ('connected', 'rescheduled', 'follow_up', 'voicemail', 'no_answer', 'wrong_number')),
	CONSTRAINT "call_organization_id_not_empty" CHECK ("call"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "call_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"call_id" text NOT NULL,
	"raw_event_id" text NOT NULL,
	"signal" text NOT NULL,
	"state_before" text,
	"state_after" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_event_call_id_raw_event_id_unique" UNIQUE("call_id","raw_event_id"),
	CONSTRAINT "call_event_organization_id_not_empty" CHECK ("call_event"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "voicemail" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"call_id" text NOT NULL,
	"contact_id" text,
	"from_e164" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"transcript" text,
	"recording_key" text,
	"listened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voicemail_call_id_unique" UNIQUE("call_id"),
	CONSTRAINT "voicemail_organization_id_not_empty" CHECK ("voicemail"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "provider_event_raw" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_event_raw" ADD COLUMN "park_reason" text;--> statement-breakpoint
ALTER TABLE "provider_event_raw" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_wallet_fk" FOREIGN KEY ("organization_id","wallet_id") REFERENCES "public"."wallet"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "public"."ledger_entry"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "public"."ledger_entry"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_event" ADD CONSTRAINT "call_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_event" ADD CONSTRAINT "call_event_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."call"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicemail" ADD CONSTRAINT "voicemail_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voicemail" ADD CONSTRAINT "voicemail_call_fk" FOREIGN KEY ("organization_id","call_id") REFERENCES "public"."call"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_reservation_close_unique" ON "ledger_entry" USING btree ("reservation_id") WHERE "ledger_entry"."kind" in ('capture', 'release');--> statement-breakpoint
CREATE INDEX "call_route_call_idx" ON "call_route" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "call_org_created_idx" ON "call" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "call_contact_created_idx" ON "call" USING btree ("contact_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "provider_event_raw" ADD CONSTRAINT "provider_event_raw_status_check" CHECK ("provider_event_raw"."status" in ('pending', 'processed', 'ignored', 'parked', 'dead_lettered'));--> statement-breakpoint
-- Hand-written: backfill the new status column for webhooks processed before it existed.
UPDATE "provider_event_raw" SET "status" = 'processed' WHERE "processed_at" IS NOT NULL;--> statement-breakpoint
-- Hand-written: Drizzle cannot express the PG15+ column-list form. SET NULL (contact_id) nulls only
-- that column; a plain SET NULL would try to null the NOT NULL organization_id.
-- Kept in sync with src/schema/voice.ts, which therefore declares no FK on contact_id.
ALTER TABLE "call" ADD CONSTRAINT "call_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE SET NULL ("contact_id");--> statement-breakpoint
ALTER TABLE "voicemail" ADD CONSTRAINT "voicemail_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE SET NULL ("contact_id");

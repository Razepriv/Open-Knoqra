CREATE TABLE "phone_number" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_number_id" text NOT NULL,
	"e164" text NOT NULL,
	"status" text NOT NULL,
	"voice" boolean NOT NULL,
	"sms" boolean NOT NULL,
	"mms" boolean NOT NULL,
	"whatsapp" boolean NOT NULL,
	"ten_dlc_status" text NOT NULL,
	"whatsapp_status" text NOT NULL,
	"assigned_use" text DEFAULT 'unassigned' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_number_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "phone_number_org_provider_number_unique" UNIQUE("organization_id","provider","provider_number_id"),
	CONSTRAINT "phone_number_org_e164_unique" UNIQUE("organization_id","e164"),
	CONSTRAINT "phone_number_provider_check" CHECK ("phone_number"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "phone_number_status_check" CHECK ("phone_number"."status" in ('active', 'pending', 'inactive')),
	CONSTRAINT "phone_number_ten_dlc_status_check" CHECK ("phone_number"."ten_dlc_status" in ('not_required', 'none', 'pending', 'registered', 'failed')),
	CONSTRAINT "phone_number_whatsapp_status_check" CHECK ("phone_number"."whatsapp_status" in ('none', 'pending', 'approved', 'rejected')),
	CONSTRAINT "phone_number_assigned_use_check" CHECK ("phone_number"."assigned_use" in ('unassigned', 'calls', 'messages', 'calls_and_messages')),
	CONSTRAINT "phone_number_organization_id_not_empty" CHECK ("phone_number"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "setup_progress" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"last_step" text,
	"audio_checked_at" timestamp with time zone,
	"test_call_id" text,
	"dismissed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_progress_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "setup_progress_last_step_check" CHECK ("setup_progress"."last_step" is null or "setup_progress"."last_step" in ('connect', 'number', 'audio', 'test_call')),
	CONSTRAINT "setup_progress_organization_id_not_empty" CHECK ("setup_progress"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "provider_balance_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"balance_micros" bigint,
	"currency" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_balance_snapshot_status_check" CHECK ("provider_balance_snapshot"."status" in ('ok', 'auth_failed', 'unavailable')),
	CONSTRAINT "provider_balance_snapshot_currency_check" CHECK ("provider_balance_snapshot"."currency" in ('USD')),
	CONSTRAINT "provider_balance_snapshot_balance_check" CHECK (("provider_balance_snapshot"."status" = 'ok') = ("provider_balance_snapshot"."balance_micros" is not null)),
	CONSTRAINT "provider_balance_snapshot_organization_id_not_empty" CHECK ("provider_balance_snapshot"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "provider_usage_record" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"service" text NOT NULL,
	"quantity" integer,
	"unit" text,
	"cost_micros" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"provider_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_usage_record_org_provider_ref_unique" UNIQUE("organization_id","provider","provider_ref"),
	CONSTRAINT "provider_usage_record_service_check" CHECK ("provider_usage_record"."service" in ('voice', 'sms', 'whatsapp')),
	CONSTRAINT "provider_usage_record_cost_check" CHECK ("provider_usage_record"."cost_micros" >= 0),
	CONSTRAINT "provider_usage_record_organization_id_not_empty" CHECK ("provider_usage_record"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "reconciliation_report" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"period_date" date NOT NULL,
	"service" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"captured_micros" bigint NOT NULL,
	"provider_micros" bigint,
	"ledger_micros" bigint NOT NULL,
	"drift_micros" bigint NOT NULL,
	"adjust_entry_id" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_report_service_check" CHECK ("reconciliation_report"."service" in ('voice')),
	CONSTRAINT "reconciliation_report_trigger_check" CHECK ("reconciliation_report"."trigger" in ('cron', 'manual')),
	CONSTRAINT "reconciliation_report_status_check" CHECK ("reconciliation_report"."status" in ('matched', 'adjusted', 'needs_review', 'provider_unavailable')),
	CONSTRAINT "reconciliation_report_adjusted_check" CHECK (("reconciliation_report"."status" = 'adjusted') = ("reconciliation_report"."adjust_entry_id" is not null)),
	CONSTRAINT "reconciliation_report_organization_id_not_empty" CHECK ("reconciliation_report"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_progress" ADD CONSTRAINT "setup_progress_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_balance_snapshot" ADD CONSTRAINT "provider_balance_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_usage_record" ADD CONSTRAINT "provider_usage_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_report" ADD CONSTRAINT "reconciliation_report_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_report" ADD CONSTRAINT "reconciliation_report_adjust_entry_fk" FOREIGN KEY ("organization_id","adjust_entry_id") REFERENCES "public"."ledger_entry"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_balance_snapshot_org_captured_idx" ON "provider_balance_snapshot" USING btree ("organization_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_usage_record_org_occurred_idx" ON "provider_usage_record" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "reconciliation_report_org_created_idx" ON "reconciliation_report" USING btree ("organization_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written: Drizzle cannot express the PG15+ column-list form. SET NULL (test_call_id) nulls only
-- that column; a plain SET NULL would try to null the NOT NULL organization_id.
-- Kept in sync with src/schema/setup.ts, which therefore declares no FK on test_call_id.
ALTER TABLE "setup_progress" ADD CONSTRAINT "setup_progress_test_call_fk" FOREIGN KEY ("organization_id","test_call_id") REFERENCES "public"."call"("organization_id","id") ON DELETE SET NULL ("test_call_id");--> statement-breakpoint
-- Hand-written (plan ruling R6): ledger.ts stays unchanged; IF NOT EXISTS keeps it merge-safe.
CREATE INDEX IF NOT EXISTS ledger_entry_org_created_idx ON ledger_entry (organization_id, created_at, id);
CREATE TABLE "cron_run" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone NOT NULL,
	"last_finished_at" timestamp with time zone,
	"last_status" text NOT NULL,
	"last_duration_ms" integer,
	CONSTRAINT "cron_run_last_status_check" CHECK ("cron_run"."last_status" in ('running', 'ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "analytics_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "provider_event_raw_unprocessed_idx" ON "provider_event_raw" USING btree ("received_at") WHERE "provider_event_raw"."processed_at" is null;
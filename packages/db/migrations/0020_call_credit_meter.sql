ALTER TABLE "call" ADD COLUMN "paid_minutes" integer;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "cutoff_reason" text;--> statement-breakpoint
ALTER TABLE "call" ADD COLUMN "cutoff_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ledger_entry_call_hold_idx" ON "ledger_entry" USING btree ("organization_id","ref_id") WHERE "ledger_entry"."kind" = 'reserve' and "ledger_entry"."ref_type" = 'call';--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_paid_minutes_positive" CHECK ("call"."paid_minutes" is null or "call"."paid_minutes" > 0);--> statement-breakpoint
ALTER TABLE "call" ADD CONSTRAINT "call_cutoff_reason_check" CHECK ("call"."cutoff_reason" is null or "call"."cutoff_reason" in ('insufficient_funds', 'stop_cap', 'paid_time_over'));
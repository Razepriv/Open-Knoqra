-- Ruling R1 (M6c): under row-level security Postgres only uses leakproof comparisons as index
-- conditions, and lower(), ILIKE, regexp_replace and row comparisons over expressions are not
-- leakproof. The contact list keyset, duplicate keys and search text become stored generated
-- columns, each equal to the expression the queries computed inline before, with partial indexes
-- whose predicates repeat the list route's archivedCondition. No app-written data changes.
-- Task 10 (Phase 1 hot paths): task gains the stored generated due_key, equal to the open list's
-- coalesce(due_at, 'infinity'), with the open-list order indexes per owner and per contact and a
-- reminder-poll index; call gains a partial index of live calls per user for /calls/active (its
-- predicate repeats the route's terminal-state list); voicemail gains its list order index; and
-- the conversation-note index on timeline_event adds (occurred_at, id) so a thread page reads only
-- its rows. Indexes and one generated column only: no app-written data changes.
DROP INDEX "contact_organization_id_lower_display_name_idx";--> statement-breakpoint
DROP INDEX "timeline_event_conversation_ref_idx";--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "sort_name" text GENERATED ALWAYS AS (lower(display_name)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "name_key" text GENERATED ALWAYS AS (lower(btrim(regexp_replace(display_name, '\s+', ' ', 'g')))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email_key" text GENERATED ALWAYS AS (lower(email)) STORED;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "search_text" text GENERATED ALWAYS AS (lower(display_name) || E'\x1f' || lower(coalesce(company, '')) || E'\x1f' || lower(coalesce(email, ''))) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "due_key" timestamp with time zone GENERATED ALWAYS AS (coalesce(due_at, 'infinity'::timestamptz)) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_active_sort_idx" ON "contact" USING btree ("organization_id","sort_name","id") WHERE archived_at is null and merged_into_id is null;--> statement-breakpoint
CREATE INDEX "contact_inactive_sort_idx" ON "contact" USING btree ("organization_id","sort_name","id") WHERE archived_at is not null or merged_into_id is not null;--> statement-breakpoint
CREATE INDEX "contact_active_name_key_idx" ON "contact" USING btree ("organization_id","name_key") WHERE archived_at is null and merged_into_id is null;--> statement-breakpoint
CREATE INDEX "contact_active_email_key_idx" ON "contact" USING btree ("organization_id","email_key") WHERE archived_at is null and merged_into_id is null and email_key is not null;--> statement-breakpoint
CREATE INDEX "task_owner_order_idx" ON "task" USING btree ("organization_id","owner_user_id","status","due_key","created_at","id");--> statement-breakpoint
CREATE INDEX "task_contact_order_idx" ON "task" USING btree ("organization_id","contact_id","status","due_key","created_at","id");--> statement-breakpoint
CREATE INDEX "task_owner_remind_idx" ON "task" USING btree ("organization_id","owner_user_id","status","remind_at");--> statement-breakpoint
CREATE INDEX "call_live_user_idx" ON "call" USING btree ("organization_id","user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE state not in ('completed', 'failed', 'busy', 'no_answer', 'canceled');--> statement-breakpoint
CREATE INDEX "voicemail_org_created_idx" ON "voicemail" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "timeline_event_conversation_ref_idx" ON "timeline_event" USING btree ("organization_id","ref_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "timeline_event"."ref_type" = 'conversation';
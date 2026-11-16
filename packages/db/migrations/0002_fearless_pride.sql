CREATE TABLE "contact_duplicate_dismissal" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_a_id" text NOT NULL,
	"contact_b_id" text NOT NULL,
	"dismissed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_duplicate_dismissal_pair_unique" UNIQUE("organization_id","contact_a_id","contact_b_id"),
	CONSTRAINT "contact_duplicate_dismissal_ordered" CHECK ("contact_duplicate_dismissal"."contact_a_id" < "contact_duplicate_dismissal"."contact_b_id"),
	CONSTRAINT "contact_duplicate_dismissal_organization_id_not_empty" CHECK ("contact_duplicate_dismissal"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "contact_permission_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"evidence" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_permission_event_channel_check" CHECK ("contact_permission_event"."channel" in ('manual_call', 'sms', 'whatsapp', 'ai_voice', 'recording')),
	CONSTRAINT "contact_permission_event_status_check" CHECK ("contact_permission_event"."status" in ('granted', 'revoked', 'opted_out', 'do_not_contact')),
	CONSTRAINT "contact_permission_event_source_check" CHECK ("contact_permission_event"."source" in ('manual', 'import', 'inbound_stop', 'merge', 'system')),
	CONSTRAINT "contact_permission_event_organization_id_not_empty" CHECK ("contact_permission_event"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text,
	"theme" text DEFAULT 'system' NOT NULL,
	"notify_email" boolean DEFAULT true NOT NULL,
	"notify_desktop" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_prefs_theme_check" CHECK ("user_prefs"."theme" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE TABLE "timeline_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"actor_user_id" text,
	"source" text DEFAULT 'app' NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_event_kind_check" CHECK ("timeline_event"."kind" in ('note', 'consent', 'system', 'call', 'message', 'task')),
	CONSTRAINT "timeline_event_organization_id_not_empty" CHECK ("timeline_event"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "job_title" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "merged_into_id" text;--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_contact_a_id_contact_id_fk" FOREIGN KEY ("contact_a_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_contact_b_id_contact_id_fk" FOREIGN KEY ("contact_b_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_permission_event" ADD CONSTRAINT "contact_permission_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_permission_event" ADD CONSTRAINT "contact_permission_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD CONSTRAINT "user_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_permission_event_contact_channel_idx" ON "contact_permission_event" USING btree ("contact_id","channel","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "timeline_event_contact_occurred_idx" ON "timeline_event" USING btree ("contact_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_merged_into_id_contact_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_organization_id_lower_display_name_idx" ON "contact" USING btree ("organization_id",lower("display_name"),"id");
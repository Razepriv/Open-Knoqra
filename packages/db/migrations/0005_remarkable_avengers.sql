CREATE TABLE "notification" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"ref_type" text,
	"ref_id" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dedupe_unique" UNIQUE("organization_id","user_id","dedupe_key"),
	CONSTRAINT "notification_kind_check" CHECK ("notification"."kind" in ('task_due', 'task_reminder', 'system')),
	CONSTRAINT "notification_organization_id_not_empty" CHECK ("notification"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "otto_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"contact_id" text,
	"channel" text,
	"instruction" text,
	"text" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otto_draft_kind_check" CHECK ("otto_draft"."kind" in ('draft', 'brief', 'digest')),
	CONSTRAINT "otto_draft_channel_check" CHECK ("otto_draft"."channel" is null or "otto_draft"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "otto_draft_organization_id_not_empty" CHECK ("otto_draft"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"contact_id" text,
	"title" text NOT NULL,
	"notes" text,
	"due_at" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_status_check" CHECK ("task"."status" in ('open', 'done')),
	CONSTRAINT "task_completed_at_check" CHECK (("task"."status" = 'done') = ("task"."completed_at" is not null)),
	CONSTRAINT "task_organization_id_not_empty" CHECK ("task"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "user_today_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"daily_goal" integer DEFAULT 6 NOT NULL,
	"widget_order" text[] DEFAULT '{}'::text[] NOT NULL,
	"hidden_widgets" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_today_prefs_daily_goal_check" CHECK ("user_today_prefs"."daily_goal" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"service" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit" text NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"provider" text NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_event_idempotency_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "usage_event_service_check" CHECK ("usage_event"."service" in ('voice', 'sms', 'whatsapp', 'ai')),
	CONSTRAINT "usage_event_quantity_check" CHECK ("usage_event"."quantity" >= 0),
	CONSTRAINT "usage_event_organization_id_not_empty" CHECK ("usage_event"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otto_draft" ADD CONSTRAINT "otto_draft_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otto_draft" ADD CONSTRAINT "otto_draft_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_today_prefs" ADD CONSTRAINT "user_today_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_user_created_idx" ON "notification" USING btree ("organization_id","user_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "task_owner_status_due_idx" ON "task" USING btree ("organization_id","owner_user_id","status","due_at");--> statement-breakpoint
CREATE INDEX "task_owner_completed_idx" ON "task" USING btree ("organization_id","owner_user_id","completed_at");--> statement-breakpoint
CREATE INDEX "usage_event_org_service_occurred_idx" ON "usage_event" USING btree ("organization_id","service","occurred_at");
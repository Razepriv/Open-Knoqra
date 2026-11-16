CREATE TABLE "channel_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"registration_status" text DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connection_organization_id_channel_unique" UNIQUE("organization_id","channel"),
	CONSTRAINT "channel_connection_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "channel_connection_channel_check" CHECK ("channel_connection"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "channel_connection_provider_check" CHECK ("channel_connection"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "channel_connection_registration_status_check" CHECK ("channel_connection"."registration_status" in ('not_started', 'pending', 'approved', 'rejected')),
	CONSTRAINT "channel_connection_organization_id_not_empty" CHECK ("channel_connection"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "channel_route" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"connection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_route_provider_channel_address_unique" UNIQUE("provider","channel","address"),
	CONSTRAINT "channel_route_channel_check" CHECK ("channel_route"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "channel_route_provider_check" CHECK ("channel_route"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "channel_route_organization_id_not_empty" CHECK ("channel_route"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"channel" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_message_preview" text,
	"last_message_direction" text,
	"last_message_status" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_organization_id_contact_id_channel_unique" UNIQUE("organization_id","contact_id","channel"),
	CONSTRAINT "conversation_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "conversation_channel_check" CHECK ("conversation"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "conversation_last_message_direction_check" CHECK ("conversation"."last_message_direction" is null or "conversation"."last_message_direction" in ('inbound', 'outbound')),
	CONSTRAINT "conversation_unread_count_check" CHECK ("conversation"."unread_count" >= 0),
	CONSTRAINT "conversation_organization_id_not_empty" CHECK ("conversation"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"template_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"client_message_id" text,
	"author_user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"status_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_organization_id_provider_provider_message_id_unique" UNIQUE("organization_id","provider","provider_message_id"),
	CONSTRAINT "message_organization_id_client_message_id_unique" UNIQUE("organization_id","client_message_id"),
	CONSTRAINT "message_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "message_channel_check" CHECK ("message"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "message_direction_check" CHECK ("message"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "message_status_check" CHECK ("message"."status" in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "message_provider_check" CHECK ("message"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "message_organization_id_not_empty" CHECK ("message"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "message_status_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"status" text NOT NULL,
	"applied" boolean NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw_event_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_status_event_status_check" CHECK ("message_status_event"."status" in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "message_status_event_organization_id_not_empty" CHECK ("message_status_event"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"approval_status" text DEFAULT 'approved' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_template_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "message_template_channel_check" CHECK ("message_template"."channel" in ('sms', 'whatsapp')),
	CONSTRAINT "message_template_approval_status_check" CHECK ("message_template"."approval_status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "message_template_organization_id_not_empty" CHECK ("message_template"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "contact_permission_event" DROP CONSTRAINT "contact_permission_event_source_check";--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_route" ADD CONSTRAINT "channel_route_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_route" ADD CONSTRAINT "channel_route_connection_fk" FOREIGN KEY ("organization_id","connection_id") REFERENCES "public"."channel_connection"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."message_template"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_event" ADD CONSTRAINT "message_status_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_status_event" ADD CONSTRAINT "message_status_event_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."message"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_inbox_idx" ON "conversation" USING btree ("organization_id","last_activity_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "message_conversation_idx" ON "message" USING btree ("conversation_id","occurred_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "message_status_event_message_idx" ON "message_status_event" USING btree ("message_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_active_name_unique" ON "message_template" USING btree ("organization_id","channel",lower("name")) WHERE "message_template"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "timeline_event_conversation_ref_idx" ON "timeline_event" USING btree ("organization_id","ref_id") WHERE "timeline_event"."ref_type" = 'conversation';--> statement-breakpoint
ALTER TABLE "contact_permission_event" ADD CONSTRAINT "contact_permission_event_source_check" CHECK ("contact_permission_event"."source" in ('manual', 'import', 'inbound_stop', 'inbound_start', 'merge', 'system'));
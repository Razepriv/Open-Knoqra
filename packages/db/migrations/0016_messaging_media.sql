CREATE TABLE "message_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer,
	"file_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"provider_media_id" text,
	"source_url" text,
	"sha256" text,
	"duration_ms" integer,
	"waveform" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachment_direction_check" CHECK ("message_attachment"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "message_attachment_kind_check" CHECK ("message_attachment"."kind" in ('image', 'audio', 'voice', 'video', 'document', 'sticker')),
	CONSTRAINT "message_attachment_status_check" CHECK ("message_attachment"."status" in ('pending', 'stored', 'failed')),
	CONSTRAINT "message_attachment_size_check" CHECK ("message_attachment"."size_bytes" is null or "message_attachment"."size_bytes" >= 0),
	CONSTRAINT "message_attachment_organization_id_not_empty" CHECK ("message_attachment"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "message_reaction" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"direction" text NOT NULL,
	"emoji" text NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"actor_user_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reaction_message_direction_unique" UNIQUE("message_id","direction"),
	CONSTRAINT "message_reaction_direction_check" CHECK ("message_reaction"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "message_reaction_status_check" CHECK ("message_reaction"."status" in ('pending', 'sent', 'failed')),
	CONSTRAINT "message_reaction_emoji_not_empty" CHECK ("message_reaction"."emoji" <> ''),
	CONSTRAINT "message_reaction_organization_id_not_empty" CHECK ("message_reaction"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "sms_registration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"phone_e164" text NOT NULL,
	"details" jsonb NOT NULL,
	"state" text DEFAULT 'submitting' NOT NULL,
	"messaging_profile_id" text,
	"brand_id" text,
	"brand_status" text,
	"campaign_id" text,
	"campaign_status" text,
	"assignment_status" text,
	"failure_reason" text,
	"created_by" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_registration_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "sms_registration_provider_check" CHECK ("sms_registration"."provider" in ('telnyx')),
	CONSTRAINT "sms_registration_entity_type_check" CHECK ("sms_registration"."entity_type" in ('sole_proprietor', 'private_profit', 'public_profit', 'non_profit')),
	CONSTRAINT "sms_registration_state_check" CHECK ("sms_registration"."state" in ('submitting', 'otp_required', 'brand_pending', 'campaign_pending', 'number_pending', 'approved', 'rejected', 'failed')),
	CONSTRAINT "sms_registration_organization_id_not_empty" CHECK ("sms_registration"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "channel_message_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "reply_to_message_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "dispatch_payload" jsonb;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "dispatch_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "whatsapp_display_name" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "whatsapp_quality_rating" text;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."message"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_conversation_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "public"."conversation"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reaction" ADD CONSTRAINT "message_reaction_message_fk" FOREIGN KEY ("organization_id","message_id") REFERENCES "public"."message"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_registration" ADD CONSTRAINT "sms_registration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_attachment_message_idx" ON "message_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_channel_message_idx" ON "message" USING btree ("organization_id","channel_message_id");--> statement-breakpoint
CREATE INDEX "message_dispatch_idx" ON "message" USING btree ("created_at") WHERE "message"."status" = 'queued' and "message"."dispatch_payload" is not null;
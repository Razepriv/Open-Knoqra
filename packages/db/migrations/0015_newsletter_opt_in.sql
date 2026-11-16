ALTER TABLE "user_prefs" ADD COLUMN "newsletter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prefs" ADD COLUMN "newsletter_updated_at" timestamp with time zone;
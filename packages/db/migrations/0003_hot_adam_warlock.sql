-- Tenant-scoped foreign keys. FK checks and referential actions bypass RLS, so a single-column
-- FK to contact(id) would let one tenant reference (or cascade-delete through) another tenant's
-- contact. Every contact reference is now composite: (organization_id, contact_id).
ALTER TABLE "contact" ADD CONSTRAINT "contact_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "contact" DROP CONSTRAINT "contact_merged_into_id_contact_id_fk";--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" DROP CONSTRAINT "contact_duplicate_dismissal_ordered";--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" DROP CONSTRAINT "contact_duplicate_dismissal_contact_a_id_contact_id_fk";--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" DROP CONSTRAINT "contact_duplicate_dismissal_contact_b_id_contact_id_fk";--> statement-breakpoint
ALTER TABLE "contact_permission_event" DROP CONSTRAINT "contact_permission_event_contact_id_contact_id_fk";--> statement-breakpoint
ALTER TABLE "timeline_event" DROP CONSTRAINT "timeline_event_contact_id_contact_id_fk";--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_contact_a_fk" FOREIGN KEY ("organization_id","contact_a_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_contact_b_fk" FOREIGN KEY ("organization_id","contact_b_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_permission_event" ADD CONSTRAINT "contact_permission_event_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_event" ADD CONSTRAINT "timeline_event_contact_fk" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_duplicate_dismissal_org_b_idx" ON "contact_duplicate_dismissal" USING btree ("organization_id","contact_b_id");--> statement-breakpoint
ALTER TABLE "contact_duplicate_dismissal" ADD CONSTRAINT "contact_duplicate_dismissal_ordered" CHECK ("contact_duplicate_dismissal"."contact_a_id" COLLATE "C" < "contact_duplicate_dismissal"."contact_b_id" COLLATE "C");--> statement-breakpoint
-- Hand-written: Drizzle cannot express the PG15+ column-list form. SET NULL (merged_into_id) nulls
-- only that column; a plain SET NULL would try to null the NOT NULL organization_id.
-- Kept in sync with src/schema/contact.ts, which therefore declares no FK on merged_into_id.
ALTER TABLE "contact" ADD CONSTRAINT "contact_merged_into_fk" FOREIGN KEY ("organization_id","merged_into_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE SET NULL ("merged_into_id");

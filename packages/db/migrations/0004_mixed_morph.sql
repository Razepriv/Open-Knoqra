-- Phone numbers are unique among unmerged contacts only: a merged source releases its number.
-- Same name as the old constraint, so the API's unique-violation check needs no change.
ALTER TABLE "contact" DROP CONSTRAINT "contact_organization_id_phone_e164_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "contact_organization_id_phone_e164_unique" ON "contact" USING btree ("organization_id","phone_e164") WHERE merged_into_id is null;
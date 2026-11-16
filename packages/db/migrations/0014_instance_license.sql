-- Self-host licensing (docs/licensing.md): instance_license is a one-row system table with no RLS,
-- holding the license key entered in the Desk. No change to existing data.
CREATE TABLE "instance_license" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"license_key" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_license_single_row" CHECK ("instance_license"."id" = 1)
);

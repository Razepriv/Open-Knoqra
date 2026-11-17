-- Otto's model connection: a workspace's own OpenAI API key, or (behind a feature flag) the tokens
-- of a ChatGPT sign-in, envelope-encrypted with the credentials master key. One row per workspace.
-- Row-level security and the account deletion function are in sql/rls.sql.
CREATE TABLE "ai_credential" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"dek_wrapped" text NOT NULL,
	"dek_iv" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"secret_last4" text,
	"model" text,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credential_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "ai_credential_kind_check" CHECK ("ai_credential"."kind" in ('api_key', 'chatgpt')),
	CONSTRAINT "ai_credential_organization_id_not_empty" CHECK ("ai_credential"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "ai_credential" ADD CONSTRAINT "ai_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "number_order" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"provider" text NOT NULL,
	"e164" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_order_id" text,
	"upfront_micros" bigint NOT NULL,
	"monthly_micros" bigint NOT NULL,
	"reservation_id" text NOT NULL,
	"failure_code" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_order_quote_id_unique" UNIQUE("quote_id"),
	CONSTRAINT "number_order_organization_id_idempotency_key_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "number_order_provider_check" CHECK ("number_order"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "number_order_status_check" CHECK ("number_order"."status" in ('pending', 'completed', 'failed')),
	CONSTRAINT "number_order_upfront_check" CHECK ("number_order"."upfront_micros" >= 0),
	CONSTRAINT "number_order_monthly_check" CHECK ("number_order"."monthly_micros" >= 0),
	CONSTRAINT "number_order_organization_id_not_empty" CHECK ("number_order"."organization_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "number_quote" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"e164" text NOT NULL,
	"upfront_micros" bigint NOT NULL,
	"monthly_micros" bigint NOT NULL,
	"currency" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_quote_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "number_quote_provider_check" CHECK ("number_quote"."provider" in ('fake', 'telnyx')),
	CONSTRAINT "number_quote_upfront_check" CHECK ("number_quote"."upfront_micros" >= 0),
	CONSTRAINT "number_quote_monthly_check" CHECK ("number_quote"."monthly_micros" >= 0),
	CONSTRAINT "number_quote_currency_check" CHECK ("number_quote"."currency" in ('USD')),
	CONSTRAINT "number_quote_organization_id_not_empty" CHECK ("number_quote"."organization_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "number_order" ADD CONSTRAINT "number_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_order" ADD CONSTRAINT "number_order_quote_fk" FOREIGN KEY ("organization_id","quote_id") REFERENCES "public"."number_quote"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_order" ADD CONSTRAINT "number_order_reservation_fk" FOREIGN KEY ("organization_id","reservation_id") REFERENCES "public"."ledger_entry"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_quote" ADD CONSTRAINT "number_quote_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "number_order_org_created_idx" ON "number_order" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "number_order_open_e164_unique" ON "number_order" USING btree ("organization_id","e164") WHERE "number_order"."status" <> 'failed';
CREATE TABLE "tool_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kid" text NOT NULL,
	"status" text NOT NULL,
	"private_key_pkcs8_pem" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_signing_keys_kid_unique" UNIQUE("kid")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_signing_keys_one_active" ON "tool_signing_keys" USING btree ("status") WHERE "tool_signing_keys"."status" = 'active';
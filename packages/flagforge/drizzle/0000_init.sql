CREATE TABLE "flags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean NOT NULL,
	"variations" jsonb NOT NULL,
	"off_variation" text NOT NULL,
	"fallthrough" jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"salt" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "flag_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"flag_key" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "flags_key_idx" ON "flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "flags_archived_idx" ON "flags" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "flag_audit_flag_key_idx" ON "flag_audit" USING btree ("flag_key");

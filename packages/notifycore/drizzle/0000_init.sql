CREATE TABLE "templates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"channel" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"channel" text NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"quiet_start" text,
	"quiet_end" text,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_recipient_channel_unique" UNIQUE("recipient","channel")
);
--> statement-breakpoint
CREATE INDEX "templates_key_idx" ON "templates" USING btree ("key");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient");--> statement-breakpoint
CREATE INDEX "notifications_idempotency_key_idx" ON "notifications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "preferences_recipient_idx" ON "preferences" USING btree ("recipient");

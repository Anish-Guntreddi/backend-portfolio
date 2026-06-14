CREATE TABLE "alert_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_action" text NOT NULL,
	"group_by_actor" boolean DEFAULT true NOT NULL,
	"threshold" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rule_id" bigint NOT NULL,
	"actor" text,
	"matched_count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_rule_idx" ON "alerts" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "alerts_triggered_idx" ON "alerts" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "events_action_idx" ON "events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "events_resource_idx" ON "events" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "events_occurred_at_idx" ON "events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "events_action_occurred_idx" ON "events" USING btree ("action","occurred_at");
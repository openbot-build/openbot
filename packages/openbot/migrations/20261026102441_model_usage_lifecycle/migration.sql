ALTER TABLE "openbot_usage_events" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ADD COLUMN "status" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ADD COLUMN "started_at" bigint;--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ADD COLUMN "reserved_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ADD COLUMN "estimated_tokens" bigint DEFAULT 0 NOT NULL;
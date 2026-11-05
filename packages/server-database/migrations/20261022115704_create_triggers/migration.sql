CREATE TABLE "openbot_triggers" (
	"organization_id" text,
	"id" text,
	"owner_user_id" text,
	"agent" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule_cron" text,
	"schedule_time_zone" text,
	"next_run_at" bigint,
	"last_fired_at" bigint,
	"hook_secret_hash" text,
	"actor" text NOT NULL,
	"enabled" boolean NOT NULL,
	"revision" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_triggers_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_triggers_id" ON "openbot_triggers" ("id");--> statement-breakpoint
CREATE INDEX "openbot_triggers_owner" ON "openbot_triggers" ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "openbot_triggers_due" ON "openbot_triggers" ("next_run_at") WHERE "next_run_at" IS NOT NULL AND "enabled";
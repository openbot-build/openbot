CREATE TABLE "openbot_execution_runners" (
	"runner_address" text PRIMARY KEY,
	"process_id" uuid NOT NULL,
	"manifest_hash" text NOT NULL,
	"active_hash" text NOT NULL,
	"plugins" jsonb NOT NULL,
	"forks" jsonb NOT NULL,
	"workflows" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openbot_execution_runners_seen" ON "openbot_execution_runners" ("seen_at");
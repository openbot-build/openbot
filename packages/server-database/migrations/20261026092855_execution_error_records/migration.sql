CREATE TABLE "openbot_execution_failures" (
	"id" text PRIMARY KEY,
	"execution_id" text,
	"cause" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_executions_id" ON "openbot_executions" ("id");
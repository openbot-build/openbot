ALTER TABLE "openbot_executions" ADD COLUMN "context_kind" text;--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD COLUMN "context_id" text;--> statement-breakpoint
CREATE INDEX "openbot_executions_context" ON "openbot_executions" ("namespace","context_kind","context_id","status");
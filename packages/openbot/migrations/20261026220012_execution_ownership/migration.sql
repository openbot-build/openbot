ALTER TABLE "openbot_executions" ADD COLUMN "owner_execution_id" text;--> statement-breakpoint
CREATE INDEX "openbot_executions_work_owner" ON "openbot_executions" ("owner_execution_id","status");--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD CONSTRAINT "openbot_executions_H8rknOXfddde_fkey" FOREIGN KEY ("owner_execution_id") REFERENCES "openbot_executions"("id");
CREATE TABLE "openbot_workflow_revisions" (
	"organization_id" text,
	"workflow_id" text,
	"revision" integer,
	"definition" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_workflow_revisions_pkey" PRIMARY KEY("organization_id","workflow_id","revision")
);
--> statement-breakpoint
CREATE TABLE "openbot_workflow_waits" (
	"organization_id" text,
	"run_id" text,
	"task" text,
	"session" text NOT NULL,
	"turn" text NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "openbot_workflow_waits_pkey" PRIMARY KEY("organization_id","run_id","task")
);
--> statement-breakpoint
ALTER TABLE "openbot_workflow_recordings" ADD COLUMN "node" text NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" ADD COLUMN "parent_run" text;--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" ADD COLUMN "parent_node" text;--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" ADD COLUMN "parent_key" text;--> statement-breakpoint
ALTER TABLE "openbot_workflows" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "openbot_workflows" ADD COLUMN "passed_revision" integer;--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" ALTER COLUMN "workflow_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_workflow_runs_parent_run" ON "openbot_workflow_runs" ("organization_id","parent_run","parent_key");--> statement-breakpoint
CREATE INDEX "openbot_workflow_waits_turn" ON "openbot_workflow_waits" ("session","turn");--> statement-breakpoint
ALTER TABLE "openbot_workflow_revisions" ADD CONSTRAINT "openbot_workflow_revisions_BkHC5J7yCb0p_fkey" FOREIGN KEY ("organization_id","workflow_id") REFERENCES "openbot_workflows"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" ADD CONSTRAINT "openbot_workflow_runs_d3FodOtfmHmq_fkey" FOREIGN KEY ("organization_id","parent_run") REFERENCES "openbot_workflow_runs"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_workflow_waits" ADD CONSTRAINT "openbot_workflow_waits_5YTRkblv18YZ_fkey" FOREIGN KEY ("organization_id","run_id") REFERENCES "openbot_workflow_runs"("organization_id","id") ON DELETE CASCADE;
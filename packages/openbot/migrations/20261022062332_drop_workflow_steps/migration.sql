DROP INDEX "openbot_workflow_runs_waiting";--> statement-breakpoint
ALTER TABLE "openbot_workflow_recordings" DROP COLUMN "step";--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" DROP COLUMN "waiting_session";--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" DROP COLUMN "waiting_turn";--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" DROP COLUMN "waiting_token";
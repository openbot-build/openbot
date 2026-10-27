ALTER TABLE "openbot_workflow_recordings" DROP CONSTRAINT "openbot_workflow_recordings_qHUhb7a5aVIj_fkey";--> statement-breakpoint
ALTER TABLE "openbot_workflow_runs" DROP CONSTRAINT "openbot_workflow_runs_vsPNiGW05x4T_fkey";--> statement-breakpoint
ALTER TABLE "openbot_workflow_revisions" DROP CONSTRAINT "openbot_workflow_revisions_BkHC5J7yCb0p_fkey";--> statement-breakpoint
ALTER TABLE "openbot_workflow_waits" DROP CONSTRAINT "openbot_workflow_waits_5YTRkblv18YZ_fkey";--> statement-breakpoint
DROP TABLE "openbot_workflow_recordings";--> statement-breakpoint
DROP TABLE "openbot_workflow_runs";--> statement-breakpoint
DROP TABLE "openbot_workflows";--> statement-breakpoint
DROP TABLE "openbot_workflow_revisions";--> statement-breakpoint
DROP TABLE "openbot_workflow_waits";--> statement-breakpoint
-- Effect made the tables of the durable execution of Workflow Runs, not Drizzle.
-- So Drizzle does not know them and does not drop them. We drop them here.
DROP TABLE IF EXISTS "openbot_cluster_locks";
--> statement-breakpoint
DROP TABLE IF EXISTS "openbot_cluster_messages";
--> statement-breakpoint
DROP TABLE IF EXISTS "openbot_cluster_migrations";
--> statement-breakpoint
DROP TABLE IF EXISTS "openbot_cluster_replies";
--> statement-breakpoint
DROP TABLE IF EXISTS "openbot_cluster_runner_migrations";
--> statement-breakpoint
DROP TABLE IF EXISTS "openbot_cluster_runners";
--> statement-breakpoint
-- The Session kind `workflow` is gone. The Sessions where Agents did the nodes of a
-- Run become direct Sessions, so people can still read them. They lose the Run id.
UPDATE "openbot_session_references"
SET "body" = (
	jsonb_set(
		("body"::jsonb),
		'{business,@openbot-build/openbot/session-host,kind}',
		'"direct"'::jsonb
	) #- '{business,@openbot-build/openbot/session-host,run}'
)::text
WHERE ("body"::jsonb) #>> '{business,@openbot-build/openbot/session-host,kind}' = 'workflow';

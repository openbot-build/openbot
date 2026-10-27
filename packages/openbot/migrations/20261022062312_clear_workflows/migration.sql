-- Workflows changed from a list of steps to a graph of nodes. Old Workflows, Runs and
-- recordings are not converted. This migration removes them.
DELETE FROM "openbot_workflow_recordings";
--> statement-breakpoint
DELETE FROM "openbot_workflow_runs";
--> statement-breakpoint
DELETE FROM "openbot_workflows";

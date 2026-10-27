ALTER TABLE "openbot_execution_commands" ADD COLUMN "cancel_epoch" integer;--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD COLUMN "cancel_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Old cancel commands belong to the phase before any new work starts.
UPDATE "openbot_executions" AS e SET "cancel_epoch" = 1
WHERE e."status" = 'cancelling' OR EXISTS (
    SELECT 1 FROM "openbot_execution_commands" AS c
    WHERE c."namespace" = e."namespace" AND c."execution_id" = e."id" AND c."kind" = 'cancel'
);--> statement-breakpoint
UPDATE "openbot_execution_commands" SET "cancel_epoch" = 1 WHERE "kind" = 'cancel';

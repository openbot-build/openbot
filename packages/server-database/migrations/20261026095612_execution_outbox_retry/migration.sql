ALTER TABLE "openbot_execution_outbox" ADD COLUMN "retry_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "openbot_execution_outbox_pending";--> statement-breakpoint
CREATE INDEX "openbot_execution_outbox_pending" ON "openbot_execution_outbox" ("retry_at","created_at") WHERE "sent_at" is null;
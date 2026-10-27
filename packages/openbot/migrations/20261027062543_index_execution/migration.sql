ALTER TABLE "openbot_app_index_jobs" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "openbot_developer_index_requests" ADD COLUMN "execution_id" text;--> statement-breakpoint
DROP INDEX "openbot_developer_index_requests_generation";--> statement-breakpoint
CREATE INDEX "openbot_developer_index_requests_generation" ON "openbot_developer_index_requests" ("namespace","owner","card_url","generation");
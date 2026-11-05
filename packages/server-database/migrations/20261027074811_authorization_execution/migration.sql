ALTER TABLE "openbot_app_authorizations" ADD COLUMN "actor" text;--> statement-breakpoint
ALTER TABLE "openbot_app_authorizations" ADD COLUMN "execution_id" text;--> statement-breakpoint
ALTER TABLE "openbot_app_connections" ADD COLUMN "execution_id" text;
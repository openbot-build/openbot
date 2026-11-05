CREATE TABLE "openbot_provider_oauth" (
	"provider_id" text PRIMARY KEY,
	"registration" text NOT NULL,
	"credentials" text
);
--> statement-breakpoint
CREATE TABLE "openbot_provider_oauth_authorizations" (
	"id" text PRIMARY KEY,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"request" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_provider_oauth_hosts" (
	"id" text PRIMARY KEY,
	"host_id" text NOT NULL
);
--> statement-breakpoint
DROP TABLE "openbot_model_account_authorizations";--> statement-breakpoint
DROP TABLE "openbot_model_account_hosts";--> statement-breakpoint
DROP TABLE "openbot_model_accounts";--> statement-breakpoint
ALTER TABLE "openbot_model_providers" ADD COLUMN "oauth" jsonb;--> statement-breakpoint
ALTER TABLE "openbot_model_providers" ALTER COLUMN "api_key" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "openbot_provider_oauth_authorizations_provider" ON "openbot_provider_oauth_authorizations" ("provider_id");--> statement-breakpoint
ALTER TABLE "openbot_provider_oauth" ADD CONSTRAINT "openbot_provider_oauth_iQxACxrG0HQs_fkey" FOREIGN KEY ("provider_id") REFERENCES "openbot_model_providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_provider_oauth_authorizations" ADD CONSTRAINT "openbot_provider_oauth_authorizations_O39JQcfcyLzt_fkey" FOREIGN KEY ("provider_id") REFERENCES "openbot_model_providers"("id") ON DELETE CASCADE;
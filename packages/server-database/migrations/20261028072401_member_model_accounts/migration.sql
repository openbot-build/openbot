CREATE TABLE "openbot_model_account_authorizations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"request" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_model_account_hosts" (
	"id" text PRIMARY KEY,
	"host_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_model_accounts" (
	"organization_id" text,
	"user_id" text,
	"registration" text NOT NULL,
	"credentials" text,
	"connected_at" bigint NOT NULL,
	CONSTRAINT "openbot_model_accounts_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "openbot_model_account_authorizations_member" ON "openbot_model_account_authorizations" ("organization_id","user_id");
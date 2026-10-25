CREATE TABLE "openbot_secret_providers" (
	"organization_id" text,
	"id" text,
	"owner_user_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"credentials" text NOT NULL,
	"hints" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_secret_providers_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_vault_access" (
	"organization_id" text,
	"vault_id" text,
	"bot" text,
	"granted_by" text NOT NULL,
	"granted_at" bigint NOT NULL,
	CONSTRAINT "openbot_vault_access_pkey" PRIMARY KEY("organization_id","vault_id","bot")
);
--> statement-breakpoint
CREATE TABLE "openbot_vault_items" (
	"organization_id" text,
	"id" text,
	"vault_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"provider_id" text,
	"source" text NOT NULL,
	"fields" text NOT NULL,
	"exits" text NOT NULL,
	"values" text,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_vault_items_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_vaults" (
	"organization_id" text,
	"id" text,
	"owner_user_id" text,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_vaults_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE INDEX "openbot_secret_providers_owner" ON "openbot_secret_providers" ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "openbot_vault_access_bot" ON "openbot_vault_access" ("organization_id","bot");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_vault_items_name" ON "openbot_vault_items" ("organization_id","vault_id","name");--> statement-breakpoint
CREATE INDEX "openbot_vault_items_provider" ON "openbot_vault_items" ("organization_id","provider_id");--> statement-breakpoint
CREATE INDEX "openbot_vaults_owner" ON "openbot_vaults" ("organization_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "openbot_vault_access" ADD CONSTRAINT "openbot_vault_access_ECcG1VGAC3Ru_fkey" FOREIGN KEY ("organization_id","vault_id") REFERENCES "openbot_vaults"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_vault_items" ADD CONSTRAINT "openbot_vault_items_374bOUnyEYRe_fkey" FOREIGN KEY ("organization_id","vault_id") REFERENCES "openbot_vaults"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_vault_items" ADD CONSTRAINT "openbot_vault_items_JOInQ3rIvhT1_fkey" FOREIGN KEY ("organization_id","provider_id") REFERENCES "openbot_secret_providers"("organization_id","id");
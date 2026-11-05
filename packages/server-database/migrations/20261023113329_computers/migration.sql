CREATE TABLE "openbot_computer_access" (
	"organization_id" text NOT NULL,
	"computer_id" text,
	"agent" text,
	"granted_by" text NOT NULL,
	"granted_at" bigint NOT NULL,
	CONSTRAINT "openbot_computer_access_pkey" PRIMARY KEY("computer_id","agent")
);
--> statement-breakpoint
CREATE TABLE "openbot_computer_calls" (
	"id" text PRIMARY KEY,
	"computer_id" text NOT NULL,
	"call" text NOT NULL,
	"reply" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_computer_pairings" (
	"id" text PRIMARY KEY,
	"code_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"machine_id" text NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"desktop" boolean NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"organization_id" text,
	"computer_id" text,
	"token" text,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_computer_providers" (
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
	CONSTRAINT "openbot_computer_providers_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_computer_usage" (
	"id" bigserial PRIMARY KEY,
	"organization_id" text NOT NULL,
	"computer_id" text NOT NULL,
	"owner_user_id" text,
	"started_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE TABLE "openbot_computers" (
	"organization_id" text,
	"id" text,
	"owner_user_id" text,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"provider_id" text,
	"template" text,
	"ref" text,
	"machine_id" text,
	"token_hash" text,
	"state" text NOT NULL,
	"features" text NOT NULL,
	"pause_after" integer,
	"created_by" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_active_at" bigint,
	CONSTRAINT "openbot_computers_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE INDEX "openbot_computer_access_agent" ON "openbot_computer_access" ("organization_id","agent");--> statement-breakpoint
CREATE INDEX "openbot_computer_calls_created" ON "openbot_computer_calls" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_computer_pairings_code" ON "openbot_computer_pairings" ("code_hash");--> statement-breakpoint
CREATE INDEX "openbot_computer_pairings_expires" ON "openbot_computer_pairings" ("expires_at");--> statement-breakpoint
CREATE INDEX "openbot_computer_providers_owner" ON "openbot_computer_providers" ("organization_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "openbot_computer_usage_computer" ON "openbot_computer_usage" ("organization_id","computer_id","started_at");--> statement-breakpoint
CREATE INDEX "openbot_computer_usage_open" ON "openbot_computer_usage" ("computer_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_computers_id" ON "openbot_computers" ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_computers_token" ON "openbot_computers" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_computers_machine" ON "openbot_computers" ("organization_id","machine_id");--> statement-breakpoint
CREATE INDEX "openbot_computers_owner" ON "openbot_computers" ("organization_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "openbot_computer_access" ADD CONSTRAINT "openbot_computer_access_i8oLhYtyGuBv_fkey" FOREIGN KEY ("organization_id","computer_id") REFERENCES "openbot_computers"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_computers" ADD CONSTRAINT "openbot_computers_5gU39IGJDtHv_fkey" FOREIGN KEY ("organization_id","provider_id") REFERENCES "openbot_computer_providers"("organization_id","id");
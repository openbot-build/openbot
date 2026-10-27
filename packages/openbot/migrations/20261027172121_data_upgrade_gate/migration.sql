CREATE TABLE "openbot_data_upgrade_failures" (
	"id" text PRIMARY KEY,
	"version" text NOT NULL,
	"step" text NOT NULL,
	"cause" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_data_upgrade_records" (
	"version" text,
	"collection" text,
	"key" text,
	"state" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_data_upgrade_records_pkey" PRIMARY KEY("version","collection","key")
);
--> statement-breakpoint
CREATE TABLE "openbot_data_upgrade_steps" (
	"version" text,
	"step" text,
	"cursor" text,
	"rows" bigint DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_data_upgrade_steps_pkey" PRIMARY KEY("version","step")
);
--> statement-breakpoint
CREATE TABLE "openbot_data_upgrades" (
	"version" text PRIMARY KEY,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"counts" text NOT NULL,
	"started_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"checked_at" bigint
);
--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_failures" ADD CONSTRAINT "openbot_data_upgrade_failures_21rHCd6gLK50_fkey" FOREIGN KEY ("version") REFERENCES "openbot_data_upgrades"("version");--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_records" ADD CONSTRAINT "openbot_data_upgrade_records_BNsODMFwq7a5_fkey" FOREIGN KEY ("version") REFERENCES "openbot_data_upgrades"("version");--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_steps" ADD CONSTRAINT "openbot_data_upgrade_steps_lqAdPZ2AiNMO_fkey" FOREIGN KEY ("version") REFERENCES "openbot_data_upgrades"("version");
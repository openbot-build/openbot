DROP INDEX "openbot_execution_commands_key";--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ADD COLUMN "principal_kind" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD COLUMN "principal_kind" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD COLUMN "service_id" text;--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_executions" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_executions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ADD CONSTRAINT "openbot_execution_commands_key" UNIQUE NULLS NOT DISTINCT("namespace","principal_kind","organization_id","user_id","service_id","key");--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ADD CONSTRAINT "openbot_execution_commands_principal" CHECK ((
			"principal_kind" = 'member' and "organization_id" is not null
			and "user_id" is not null and "service_id" is null
		) or (
			"principal_kind" = 'service' and "user_id" is null
			and "service_id" is not null
		));--> statement-breakpoint
ALTER TABLE "openbot_executions" ADD CONSTRAINT "openbot_executions_principal" CHECK ((
			"principal_kind" = 'member' and "organization_id" is not null
			and "user_id" is not null and "service_id" is null
		) or (
			"principal_kind" = 'service' and "user_id" is null
			and "service_id" is not null
		));
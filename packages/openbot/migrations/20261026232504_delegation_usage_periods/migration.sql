CREATE TABLE "openbot_delegation_periods" (
	"namespace" text,
	"execution_id" text,
	"epoch" integer,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	CONSTRAINT "openbot_delegation_periods_pkey" PRIMARY KEY("namespace","execution_id","epoch")
);
--> statement-breakpoint
CREATE INDEX "openbot_usage_events_execution" ON "openbot_usage_events" ("execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_delegation_periods_open" ON "openbot_delegation_periods" ("namespace","execution_id") WHERE "ended_at" is null;--> statement-breakpoint
ALTER TABLE "openbot_delegation_periods" ADD CONSTRAINT "openbot_delegation_periods_2nu1Mt8vpUZO_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");
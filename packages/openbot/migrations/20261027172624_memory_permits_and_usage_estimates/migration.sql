CREATE TABLE "openbot_execution_permits" (
	"namespace" text,
	"execution_id" text,
	"generation" integer NOT NULL,
	"id" text,
	"pool" text NOT NULL,
	"deadline" bigint NOT NULL,
	CONSTRAINT "openbot_execution_permits_pkey" PRIMARY KEY("namespace","execution_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_resource_leases" (
	"lease" text PRIMARY KEY,
	"namespace" text NOT NULL,
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"node" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"result" text
);
--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ADD COLUMN "estimated_micros" bigint;--> statement-breakpoint
CREATE INDEX "openbot_execution_permits_pool" ON "openbot_execution_permits" ("pool","deadline");--> statement-breakpoint
CREATE INDEX "openbot_resource_leases_resource" ON "openbot_resource_leases" ("namespace","kind","id");--> statement-breakpoint
ALTER TABLE "openbot_execution_permits" ADD CONSTRAINT "openbot_execution_permits_K5nTJ0nXb9Nk_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");
--> statement-breakpoint
UPDATE "openbot_usage_events" SET "estimated_micros" = "reserved_micros"
WHERE "status" = 'pending' OR "reserved_micros" <> 0 OR ("status" = 'unknown' AND "reservation_known");
--> statement-breakpoint
UPDATE "openbot_usage_events" SET "reserved_micros" = 0 WHERE "status" = 'unknown';

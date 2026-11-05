CREATE TABLE "openbot_grant_uses" (
	"namespace" text,
	"turn_execution_id" text,
	"call_key" text,
	"organization_id" text NOT NULL,
	"grant_id" text NOT NULL,
	CONSTRAINT "openbot_grant_uses_pkey" PRIMARY KEY("namespace","turn_execution_id","call_key")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_grant_uses_grant" ON "openbot_grant_uses" ("organization_id","grant_id");--> statement-breakpoint
ALTER TABLE "openbot_grant_uses" ADD CONSTRAINT "openbot_grant_uses_T28NdeuQhaQq_fkey" FOREIGN KEY ("namespace","turn_execution_id") REFERENCES "openbot_executions"("namespace","id");
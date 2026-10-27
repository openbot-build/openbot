CREATE TABLE "openbot_code_executions" (
	"namespace" text,
	"execution_id" text,
	"id" text NOT NULL,
	"source_execution_id" text NOT NULL,
	CONSTRAINT "openbot_code_executions_pkey" PRIMARY KEY("namespace","execution_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_code_executions_id" ON "openbot_code_executions" ("namespace","id");--> statement-breakpoint
CREATE INDEX "openbot_code_executions_source" ON "openbot_code_executions" ("namespace","source_execution_id");--> statement-breakpoint
ALTER TABLE "openbot_code_executions" ADD CONSTRAINT "openbot_code_executions_dP8K0twD5JsE_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_code_executions" ADD CONSTRAINT "openbot_code_executions_GQY4PivduQRm_fkey" FOREIGN KEY ("namespace","source_execution_id") REFERENCES "openbot_executions"("namespace","id");
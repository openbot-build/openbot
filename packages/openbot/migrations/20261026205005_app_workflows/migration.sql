CREATE TABLE "openbot_app_executions" (
	"namespace" text,
	"execution_id" text,
	"id" text NOT NULL,
	"source_execution_id" text NOT NULL,
	CONSTRAINT "openbot_app_executions_pkey" PRIMARY KEY("namespace","execution_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_inputs" (
	"namespace" text,
	"execution_id" text,
	"round" integer,
	"body" text NOT NULL,
	CONSTRAINT "openbot_app_inputs_pkey" PRIMARY KEY("namespace","execution_id","round")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_app_executions_id" ON "openbot_app_executions" ("namespace","id");--> statement-breakpoint
CREATE INDEX "openbot_app_executions_source" ON "openbot_app_executions" ("namespace","source_execution_id");--> statement-breakpoint
ALTER TABLE "openbot_app_executions" ADD CONSTRAINT "openbot_app_executions_ydPy9Lrqrrrw_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_app_executions" ADD CONSTRAINT "openbot_app_executions_4m3o1mFr81Qy_fkey" FOREIGN KEY ("namespace","source_execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_app_inputs" ADD CONSTRAINT "openbot_app_inputs_9F4Gyaarn96t_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_app_executions"("namespace","execution_id");
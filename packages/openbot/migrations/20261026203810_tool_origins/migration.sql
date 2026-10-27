CREATE TABLE "openbot_tool_origins" (
	"namespace" text,
	"execution_id" text,
	"tool_execution_id" text NOT NULL,
	"path" text[] NOT NULL,
	CONSTRAINT "openbot_tool_origins_pkey" PRIMARY KEY("namespace","execution_id")
);
--> statement-breakpoint
ALTER TABLE "openbot_tool_origins" ADD CONSTRAINT "openbot_tool_origins_wOnBcHGs2yUH_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_tool_origins" ADD CONSTRAINT "openbot_tool_origins_2dVTliuGcN0g_fkey" FOREIGN KEY ("namespace","tool_execution_id") REFERENCES "openbot_tool_executions"("namespace","execution_id");
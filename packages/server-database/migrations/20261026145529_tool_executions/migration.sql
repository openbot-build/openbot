CREATE TABLE "openbot_tool_executions" (
	"namespace" text,
	"id" text,
	"execution_id" text NOT NULL,
	"parent_execution_id" text NOT NULL,
	"chat" text NOT NULL,
	"turn" text NOT NULL,
	"item" text NOT NULL,
	"call_id" text NOT NULL,
	"detached" boolean DEFAULT false NOT NULL,
	CONSTRAINT "openbot_tool_executions_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_tool_executions_execution" ON "openbot_tool_executions" ("namespace","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_tool_executions_call" ON "openbot_tool_executions" ("namespace","parent_execution_id","item","call_id");--> statement-breakpoint
CREATE INDEX "openbot_tool_executions_chat" ON "openbot_tool_executions" ("namespace","chat");--> statement-breakpoint
ALTER TABLE "openbot_tool_executions" ADD CONSTRAINT "openbot_tool_executions_f6JVGzvig7ID_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_tool_executions" ADD CONSTRAINT "openbot_tool_executions_RDkKn7rsXUZe_fkey" FOREIGN KEY ("namespace","parent_execution_id") REFERENCES "openbot_executions"("namespace","id");
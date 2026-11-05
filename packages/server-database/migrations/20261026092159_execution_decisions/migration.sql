CREATE TABLE "openbot_execution_decisions" (
	"namespace" text,
	"execution_id" text,
	"id" text,
	"choices" text NOT NULL,
	"answer" text,
	"created_at" bigint NOT NULL,
	"answered_at" bigint,
	CONSTRAINT "openbot_execution_decisions_pkey" PRIMARY KEY("namespace","execution_id","id")
);
--> statement-breakpoint
ALTER TABLE "openbot_execution_decisions" ADD CONSTRAINT "openbot_execution_decisions_EcAlMfnl5jqv_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");
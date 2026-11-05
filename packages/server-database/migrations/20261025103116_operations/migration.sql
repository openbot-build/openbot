CREATE TABLE "openbot_operations" (
	"namespace" text,
	"id" text,
	"chat" text NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	"heartbeat_at" bigint NOT NULL,
	"started_at" bigint NOT NULL,
	CONSTRAINT "openbot_operations_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE INDEX "openbot_operations_chat" ON "openbot_operations" ("namespace","chat","started_at");--> statement-breakpoint
CREATE INDEX "openbot_operations_running" ON "openbot_operations" ("heartbeat_at") WHERE "status" = 'Running';
CREATE TABLE "openbot_code_runs" (
	"owner" text,
	"id" text,
	"session" text NOT NULL,
	"call_id" text NOT NULL,
	"status" text NOT NULL,
	"lease_until" bigint,
	"body" text NOT NULL,
	CONSTRAINT "openbot_code_runs_pkey" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
CREATE INDEX "openbot_code_runs_session" ON "openbot_code_runs" ("owner","session");
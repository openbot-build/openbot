CREATE TABLE "openbot_app_grant_uses" (
	"namespace" text,
	"kind" text,
	"reference" text,
	"scope_key" text NOT NULL,
	"execution_id" text,
	CONSTRAINT "openbot_app_grant_uses_pkey" PRIMARY KEY("namespace","kind","reference")
);
--> statement-breakpoint
CREATE INDEX "openbot_app_grant_uses_scope" ON "openbot_app_grant_uses" ("scope_key","kind");
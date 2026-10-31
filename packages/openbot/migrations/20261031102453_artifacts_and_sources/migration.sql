CREATE TABLE "openbot_artifact_citation_intents" (
	"namespace" text,
	"chat" text NOT NULL,
	"turn" text NOT NULL,
	"call_id" text,
	"after_step" integer NOT NULL,
	"citations" text NOT NULL,
	CONSTRAINT "openbot_artifact_citation_intents_pkey" PRIMARY KEY("namespace","call_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_artifact_citations" (
	"namespace" text,
	"chat" text,
	"item" text,
	"citations" text NOT NULL,
	CONSTRAINT "openbot_artifact_citations_pkey" PRIMARY KEY("namespace","chat","item")
);
--> statement-breakpoint
CREATE TABLE "openbot_artifact_files" (
	"file" text PRIMARY KEY,
	"namespace" text NOT NULL,
	"chat" text NOT NULL,
	"execution_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_artifact_jobs" (
	"execution_id" text PRIMARY KEY,
	"namespace" text NOT NULL,
	"chat" text NOT NULL,
	"file" text NOT NULL,
	"resource_id" text NOT NULL,
	"snapshot" text,
	"metadata" text,
	"sha256" text,
	"result" text
);
--> statement-breakpoint
CREATE TABLE "openbot_artifact_sources" (
	"id" text PRIMARY KEY,
	"namespace" text NOT NULL,
	"chat" text NOT NULL,
	"file" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_artifact_versions" (
	"artifact" text,
	"version" integer,
	"namespace" text NOT NULL,
	"chat" text NOT NULL,
	"turn" text,
	"item" text,
	"file" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "openbot_artifact_versions_pkey" PRIMARY KEY("artifact","version")
);
--> statement-breakpoint
CREATE TABLE "openbot_artifacts" (
	"id" text PRIMARY KEY,
	"namespace" text NOT NULL,
	"chat" text NOT NULL,
	"title" text NOT NULL,
	"latest_version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openbot_artifact_citation_intents_turn" ON "openbot_artifact_citation_intents" ("namespace","chat","turn");--> statement-breakpoint
CREATE INDEX "openbot_artifact_jobs_file" ON "openbot_artifact_jobs" ("file");--> statement-breakpoint
CREATE INDEX "openbot_artifact_sources_chat" ON "openbot_artifact_sources" ("namespace","chat","id");--> statement-breakpoint
CREATE INDEX "openbot_artifact_versions_item" ON "openbot_artifact_versions" ("namespace","chat","item");--> statement-breakpoint
CREATE INDEX "openbot_artifacts_chat" ON "openbot_artifacts" ("namespace","chat","id");
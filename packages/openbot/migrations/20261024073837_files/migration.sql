CREATE TABLE "openbot_file_refs" (
	"file" text,
	"namespace" text,
	"chat" text,
	CONSTRAINT "openbot_file_refs_pkey" PRIMARY KEY("file","namespace","chat")
);
--> statement-breakpoint
CREATE TABLE "openbot_files" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"status" text NOT NULL,
	"object_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openbot_file_refs_chat" ON "openbot_file_refs" ("namespace","chat");--> statement-breakpoint
CREATE INDEX "openbot_files_owner" ON "openbot_files" ("organization_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "openbot_files_status" ON "openbot_files" ("status","updated_at");--> statement-breakpoint
ALTER TABLE "openbot_files" ADD CONSTRAINT "openbot_files_organization_id_openbot_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;
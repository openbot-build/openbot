CREATE TABLE "openbot_invitations" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"roles" text NOT NULL,
	"status" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openbot_invitations_organization" ON "openbot_invitations" ("organization_id");--> statement-breakpoint
CREATE INDEX "openbot_invitations_email" ON "openbot_invitations" ("email");--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD CONSTRAINT "openbot_invitations_gAkSdzmBM60d_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;
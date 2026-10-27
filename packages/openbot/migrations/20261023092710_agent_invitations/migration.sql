ALTER TABLE "openbot_invitations" ADD COLUMN "target" text DEFAULT 'organization' NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "prefix" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "secret_hash" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "secret" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_invitations" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_invitations_secret" ON "openbot_invitations" ("secret_hash");
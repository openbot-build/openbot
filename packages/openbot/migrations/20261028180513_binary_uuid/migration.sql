-- Drizzle does not drop these keys when it changes their column types.
ALTER TABLE "openbot_developer_invitations" DROP CONSTRAINT "openbot_developer_invitations_syY7e9iPktkd_fkey";--> statement-breakpoint
ALTER TABLE "openbot_developer_members" DROP CONSTRAINT "openbot_developer_members_xpS4GhBwzZLS_fkey";--> statement-breakpoint
ALTER TABLE "openbot_developer_proofs" DROP CONSTRAINT "openbot_developer_proofs_PQq5YDEc675j_fkey";--> statement-breakpoint
ALTER TABLE "openbot_execution_outbox" DROP CONSTRAINT "openbot_execution_outbox_GWA2ehVylThG_fkey";--> statement-breakpoint
ALTER TABLE "openbot_app_drafts" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_claims" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_index_requests" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_invitations" ALTER COLUMN "proof_id" SET DATA TYPE uuid USING "proof_id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_members" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_members" ALTER COLUMN "proof_id" SET DATA TYPE uuid USING "proof_id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_notices" ALTER COLUMN "report_id" SET DATA TYPE uuid USING "report_id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_proofs" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_reports" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_tokens" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_execution_outbox" ALTER COLUMN "command_id" SET DATA TYPE uuid USING "command_id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_resource_owners" ALTER COLUMN "lease" SET DATA TYPE uuid USING "lease"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_resource_owners" ALTER COLUMN "node" SET DATA TYPE uuid USING "node"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_failures" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_execution_permits" ALTER COLUMN "id" SET DATA TYPE uuid USING "id"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_resource_leases" ALTER COLUMN "lease" SET DATA TYPE uuid USING "lease"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_resource_leases" ALTER COLUMN "node" SET DATA TYPE uuid USING "node"::uuid;--> statement-breakpoint
ALTER TABLE "openbot_developer_invitations" ADD CONSTRAINT "openbot_developer_invitations_syY7e9iPktkd_fkey" FOREIGN KEY ("namespace","proof_id") REFERENCES "openbot_developer_proofs"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_developer_members" ADD CONSTRAINT "openbot_developer_members_xpS4GhBwzZLS_fkey" FOREIGN KEY ("namespace","proof_id") REFERENCES "openbot_developer_proofs"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_developer_proofs" ADD CONSTRAINT "openbot_developer_proofs_PQq5YDEc675j_fkey" FOREIGN KEY ("namespace","id") REFERENCES "openbot_developer_claims"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_execution_outbox" ADD CONSTRAINT "openbot_execution_outbox_GWA2ehVylThG_fkey" FOREIGN KEY ("namespace","command_id") REFERENCES "openbot_execution_commands"("namespace","id");

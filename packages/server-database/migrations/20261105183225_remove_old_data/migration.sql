-- This version reads no data in the forms of older versions. It needs a new
-- database. Before it drops the old tables and makes columns required, this
-- migration stops when it finds data of an older version. It changes no row.
DO $$
DECLARE
	found text;
BEGIN
	IF EXISTS (SELECT 1 FROM openbot_executions WHERE workflow = 'openbot.imported-record') THEN
		found := 'imported work';
	ELSIF EXISTS (SELECT 1 FROM openbot_data_upgrades)
		OR EXISTS (SELECT 1 FROM openbot_data_upgrade_steps)
		OR EXISTS (SELECT 1 FROM openbot_data_upgrade_records)
		OR EXISTS (SELECT 1 FROM openbot_data_upgrade_failures) THEN
		found := 'records of a data move';
	ELSIF EXISTS (SELECT 1 FROM openbot_app_invocations)
		OR EXISTS (SELECT 1 FROM openbot_code_runs)
		OR EXISTS (SELECT 1 FROM openbot_computer_calls)
		OR EXISTS (SELECT 1 FROM openbot_operations) THEN
		found := 'rows of a table that this version drops';
	ELSIF EXISTS (
		SELECT 1 FROM openbot_chats c
		WHERE EXISTS (
			SELECT 1 FROM jsonb_object_keys(
				CASE WHEN jsonb_typeof(c.body::jsonb -> 'business') = 'object'
				THEN c.body::jsonb -> 'business' ELSE '{}'::jsonb END
			) AS k WHERE k LIKE '@openbot-build/openbot/%'
		) OR EXISTS (
			SELECT 1 FROM jsonb_object_keys(
				CASE WHEN jsonb_typeof(c.state::jsonb) = 'object'
				THEN c.state::jsonb ELSE '{}'::jsonb END
			) AS k WHERE k LIKE '@openbot-build/openbot/%'
		)
	) THEN
		found := 'Chat data under old names';
	ELSIF EXISTS (
		SELECT 1 FROM openbot_settings
		WHERE (scope_kind = 'platform' AND NOT (
				document::jsonb ?& array['registration', 'codeMode', 'rateLimit', 'tokenRate', 'files', 'mail']
				AND document::jsonb -> 'files' ? 'quotaBytes'
			))
			OR (scope_kind = 'organization' AND NOT document::jsonb ?& array['delegationTimeLimitMs', 'toolForegroundBudgetMs', 'toolMaxDurationMs', 'maxBackgroundOperations', 'tokenRate'])
			OR (scope_kind = 'member' AND NOT document::jsonb ? 'defaultBot')
	) THEN
		found := 'settings without a value that this version needs';
	ELSIF EXISTS (
		SELECT 1 FROM openbot_usage_events
		WHERE status IN ('pending', 'unknown') AND reserved_micros <> estimated_micros
	) THEN
		found := 'usage holds of an older version';
	ELSIF EXISTS (SELECT 1 FROM openbot_usage_events WHERE started_at IS NULL OR estimated_micros IS NULL)
		OR EXISTS (SELECT 1 FROM openbot_channels WHERE execution_id IS NULL)
		OR EXISTS (SELECT 1 FROM openbot_channel_inbox WHERE execution_id IS NULL)
		OR EXISTS (SELECT 1 FROM openbot_channel_deliveries WHERE execution_id IS NULL)
		OR EXISTS (SELECT 1 FROM openbot_developer_index_requests WHERE execution_id IS NULL)
		OR EXISTS (SELECT 1 FROM openbot_app_authorizations WHERE actor IS NULL OR execution_id IS NULL) THEN
		found := 'rows without a value that this version needs';
	END IF;
	IF found IS NOT NULL THEN
		RAISE EXCEPTION 'This database holds data of an older OpenBot version (%). This version works only with a new database. Make a new database and run openbot migrate on it.', found;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_failures" DROP CONSTRAINT "openbot_data_upgrade_failures_21rHCd6gLK50_fkey";--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_records" DROP CONSTRAINT "openbot_data_upgrade_records_BNsODMFwq7a5_fkey";--> statement-breakpoint
ALTER TABLE "openbot_data_upgrade_steps" DROP CONSTRAINT "openbot_data_upgrade_steps_lqAdPZ2AiNMO_fkey";--> statement-breakpoint
DROP TABLE "openbot_app_invocations";--> statement-breakpoint
DROP TABLE "openbot_code_runs";--> statement-breakpoint
DROP TABLE "openbot_computer_calls";--> statement-breakpoint
DROP TABLE "openbot_operations";--> statement-breakpoint
DROP TABLE "openbot_data_upgrade_failures";--> statement-breakpoint
DROP TABLE "openbot_data_upgrade_records";--> statement-breakpoint
DROP TABLE "openbot_data_upgrade_steps";--> statement-breakpoint
DROP TABLE "openbot_data_upgrades";--> statement-breakpoint
DROP INDEX "openbot_channel_inbox_open";--> statement-breakpoint
DROP INDEX "openbot_channel_deliveries_turn";--> statement-breakpoint
DROP INDEX "openbot_channel_deliveries_due";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "target";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "chat";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "turn";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "body";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "next_at";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "claim";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "event";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "received_at";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "next_at";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "claim";--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "openbot_usage_events" DROP COLUMN "reservation_known";--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ALTER COLUMN "started_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" ALTER COLUMN "execution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" ALTER COLUMN "execution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_channels" ALTER COLUMN "execution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_developer_index_requests" ALTER COLUMN "execution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_app_authorizations" ALTER COLUMN "actor" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_app_authorizations" ALTER COLUMN "execution_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "openbot_usage_events" ALTER COLUMN "estimated_micros" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "openbot_channel_inbox_conversation" ON "openbot_channel_inbox" ("channel_id","conversation_key","position");

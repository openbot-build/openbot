ALTER TABLE "openbot_agent_memories" RENAME TO "openbot_bot_memories";--> statement-breakpoint
ALTER TABLE "openbot_agent_memory_tags" RENAME TO "openbot_bot_memory_tags";--> statement-breakpoint
ALTER TABLE "openbot_agent_records" RENAME TO "openbot_bot_records";--> statement-breakpoint
ALTER TABLE "openbot_bot_memories" RENAME COLUMN "home_agent" TO "home_bot";--> statement-breakpoint
ALTER TABLE "openbot_bot_memory_tags" RENAME COLUMN "home_agent" TO "home_bot";--> statement-breakpoint
ALTER TABLE "openbot_channels" RENAME COLUMN "agent" TO "bot";--> statement-breakpoint
ALTER TABLE "openbot_computer_access" RENAME COLUMN "agent" TO "bot";--> statement-breakpoint
ALTER TABLE "openbot_invitations" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER TABLE "openbot_invitations" RENAME COLUMN "agent_name" TO "bot_name";--> statement-breakpoint
ALTER TABLE "openbot_triggers" RENAME COLUMN "agent" TO "bot";--> statement-breakpoint
ALTER TABLE "openbot_usage_events" RENAME COLUMN "agent_id" TO "bot_id";--> statement-breakpoint
ALTER INDEX "openbot_agent_memories_updated" RENAME TO "openbot_bot_memories_updated";--> statement-breakpoint
ALTER INDEX "openbot_agent_memory_tags_tag" RENAME TO "openbot_bot_memory_tags_tag";--> statement-breakpoint
ALTER INDEX "openbot_agent_records_owner" RENAME TO "openbot_bot_records_owner";--> statement-breakpoint
ALTER INDEX "openbot_agent_records_scope" RENAME TO "openbot_bot_records_scope";--> statement-breakpoint
ALTER INDEX "openbot_agent_records_status" RENAME TO "openbot_bot_records_status";--> statement-breakpoint
ALTER INDEX "openbot_computer_access_agent" RENAME TO "openbot_computer_access_bot";--> statement-breakpoint
ALTER INDEX "openbot_usage_events_agent" RENAME TO "openbot_usage_events_bot";--> statement-breakpoint
-- Agents are now called Bots. The statements above rename the tables, columns and
-- indexes. This part renames the words in the stored values, so old rows still decode:
-- - In JSON text, each key and each short word value, such as "agentId", "agent",
--   "agents.read" or "for:agent". A "_tag" value such as "Agent" becomes "Bot".
-- - In a column that holds one short word, such as a kind, a scope or a tag.
-- Free text, such as instructions, memory and messages, does not change.
-- JSON escapes a quote inside a string as \", so a quote rule never matches free text
-- in a JSON string.
CREATE FUNCTION pg_temp.openbot_bot_word(value text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
	token constant text := '[A-Za-z0-9_.:{}*/-]';
	result text := value;
	before text;
BEGIN
	IF result IS NULL OR result !~ '[Aa]gent' THEN
		RETURN result;
	END IF;
	IF result ~ '^\s*[\[{]' THEN
		LOOP
			before := result;
			-- A key, such as "homeAgent" or "agent_id".
			result := regexp_replace(result, '(?<!\\)"([A-Za-z0-9_]*)agent([A-Za-z0-9_]*)":', '"\1bot\2":', 'g');
			result := regexp_replace(result, '(?<!\\)"([A-Za-z0-9_]*)Agent([A-Za-z0-9_]*)":', '"\1Bot\2":', 'g');
			-- A tag, such as {"_tag":"Agent"}.
			result := regexp_replace(result, '"_tag":(\s*)"([A-Za-z]*)Agent([A-Za-z]*)"', '"_tag":\1"\2Bot\3"', 'g');
			-- A short word value, such as "agent:org_1:agt_1" or "openbot.org.{org}.agent".
			result := regexp_replace(
				result,
				'(?<!\\)"(' || token || '*[._:]|)agent(s?)((?:[._:]' || token || '*)?)"',
				'"\1bot\2\3"',
				'g'
			);
			EXIT WHEN result = before;
		END LOOP;
	ELSIF result ~ ('^' || token || '+$') THEN
		LOOP
			before := result;
			result := regexp_replace(
				result,
				'^(' || token || '*[._:]|)agent(s?)((?:[._:]' || token || '*)?)$',
				'\1bot\2\3'
			);
			EXIT WHEN result = before;
		END LOOP;
	END IF;
	RETURN result;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
	target record;
BEGIN
	-- Secrets and hashes are random text. They are not words, so they do not change.
	FOR target IN
		SELECT c.table_name, c.column_name, c.data_type
		FROM information_schema.columns c
		JOIN information_schema.tables t
			ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = current_schema()
			AND t.table_type = 'BASE TABLE'
			AND c.table_name LIKE 'openbot\_%'
			AND c.table_name NOT LIKE 'openbot\_auth\_%'
			AND c.column_name !~ '(secret|hash|credential|sealed|password)'
			AND c.data_type IN ('text', 'character varying', 'json', 'jsonb')
	LOOP
		EXECUTE format(
			'UPDATE %1$I SET %2$I = pg_temp.openbot_bot_word(%2$I::text)::%3$s WHERE %2$I::text ~ ''[Aa]gent'' AND pg_temp.openbot_bot_word(%2$I::text) IS DISTINCT FROM %2$I::text',
			target.table_name, target.column_name, target.data_type
		);
	END LOOP;
END
$$;
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_bot_word(text);

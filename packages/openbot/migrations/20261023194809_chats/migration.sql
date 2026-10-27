CREATE TABLE "openbot_chat_items" (
	"namespace" text,
	"chat" text,
	"seq" integer,
	"id" text NOT NULL,
	"turn" text,
	"value" text NOT NULL,
	CONSTRAINT "openbot_chat_items_pkey" PRIMARY KEY("namespace","chat","seq")
);
--> statement-breakpoint
CREATE TABLE "openbot_chat_turns" (
	"namespace" text,
	"chat" text,
	"id" text,
	"position" bigserial,
	"value" text NOT NULL,
	CONSTRAINT "openbot_chat_turns_pkey" PRIMARY KEY("namespace","chat","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_chats" (
	"namespace" text,
	"id" text,
	"body" text NOT NULL,
	"state" text NOT NULL,
	"bot" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"turn" text,
	"revision" integer NOT NULL,
	"inbox_size" integer NOT NULL,
	"runner_seen_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_chats_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
-- Sessions become Chats. A Chat keeps only one log of Items, with no versions.
-- These Sessions stay, and the others go:
-- - every Session of a chat of a Channel, and
-- - for each Bot in each namespace, the one direct Session with the newest Turn.
-- A Session row has no time, so the start times of its Turns tell which one is the newest.
CREATE TEMPORARY TABLE openbot_kept_sessions AS
WITH sessions AS (
	SELECT
		r.namespace,
		r.id,
		r.head,
		r.body::jsonb AS body,
		r.body::jsonb -> 'business' -> '@openbot-build/openbot/session-host' AS host
	FROM openbot_session_references r
),
channel AS (
	-- Each chat of a Channel names its Session. Session IDs are random, so the ID finds it.
	SELECT DISTINCT ON (s.namespace, s.id) s.namespace, s.id, c.title
	FROM sessions s
	JOIN openbot_channel_conversations c ON c.session = s.id
	WHERE jsonb_typeof(s.host) = 'object' AND s.host ? 'bot'
	ORDER BY s.namespace, s.id
),
direct AS (
	SELECT DISTINCT ON (s.namespace, s.host ->> 'bot') s.namespace, s.id
	FROM sessions s
	WHERE jsonb_typeof(s.host) = 'object'
		AND s.host ->> 'kind' = 'direct'
		AND s.host ? 'bot'
		AND NOT EXISTS (
			SELECT 1 FROM channel c WHERE c.namespace = s.namespace AND c.id = s.id
		)
	ORDER BY
		s.namespace,
		s.host ->> 'bot',
		(
			SELECT max((turn ->> 'startedAt')::numeric)
			FROM jsonb_array_elements(s.body -> 'turns') AS a(turn)
		) DESC NULLS LAST,
		s.id DESC
)
SELECT
	s.namespace,
	s.id,
	s.body,
	s.host,
	CASE WHEN c.id IS NULL THEN 'direct' ELSE 'channel' END AS kind,
	COALESCE(s.body -> 'metadata' ->> 'title', c.title) AS title,
	v.value::jsonb AS value,
	v.history::jsonb AS history,
	-- The Turns that did not end: `Running` or `Waiting`.
	ARRAY(
		SELECT turn ->> 'id'
		FROM jsonb_array_elements(s.body -> 'turns') AS a(turn)
		WHERE turn -> 'status' ->> '_tag' IN ('Running', 'Waiting')
	) AS unfinished
FROM sessions s
LEFT JOIN channel c ON c.namespace = s.namespace AND c.id = s.id
JOIN openbot_timeline_versions v ON v.namespace = s.namespace AND v.id = s.head
WHERE c.id IS NOT NULL
	OR EXISTS (SELECT 1 FROM direct d WHERE d.namespace = s.namespace AND d.id = s.id);
--> statement-breakpoint
-- The Items of the head version of each kept Session, in history order.
-- The Items of a Turn that did not end go, because they can hold a tool call without a
-- result, and a provider does not take such a history.
CREATE TEMPORARY TABLE openbot_kept_items AS
SELECT
	k.namespace,
	k.id AS chat,
	h.place,
	h.entry ->> 'message' AS id,
	c.content::jsonb AS payload,
	c.content::jsonb -> 'origin' ->> 'turn' AS turn,
	COALESCE((c.content::jsonb -> 'origin' ->> 'turn') = ANY (k.unfinished), false) AS dropped
FROM pg_temp.openbot_kept_sessions k
CROSS JOIN LATERAL jsonb_array_elements(k.history) WITH ORDINALITY AS h(entry, place)
JOIN openbot_timeline_contents c ON c.namespace = k.namespace AND c.id = h.entry ->> 'content';
--> statement-breakpoint
-- The next statements read the Items of one Chat at a time.
CREATE INDEX ON pg_temp.openbot_kept_items (namespace, chat, place);
--> statement-breakpoint
ANALYZE pg_temp.openbot_kept_items;
--> statement-breakpoint
-- A Turn of a Chat. `start` and `end` named Timeline versions, and a Chat has none, so
-- they go. A Turn that did not end becomes `Interrupted`, and it has no Items any more.
CREATE FUNCTION pg_temp.openbot_chat_turn(turn jsonb, chat text) RETURNS jsonb
LANGUAGE sql STRICT AS $$
	SELECT CASE
		WHEN turn -> 'status' ->> '_tag' IN ('Running', 'Waiting') THEN
			(turn - 'session' - 'start' - 'end' - 'activeAction') || jsonb_build_object(
				'chat', chat,
				'status', jsonb_build_object('_tag', 'Interrupted'),
				'input', '[]'::jsonb,
				'items', '[]'::jsonb
			)
		ELSE (turn - 'session' - 'start' - 'end') || jsonb_build_object('chat', chat)
	END
$$;
--> statement-breakpoint
-- The OpenBot data of a Chat. Only the fields that a direct or a channel Chat has stay.
-- The memory switches of a Session go, because learned Session memory is gone.
CREATE FUNCTION pg_temp.openbot_chat_host(host jsonb, kind text, title text) RETURNS jsonb
LANGUAGE sql AS $$
	SELECT jsonb_build_object(
		'bot', host -> 'bot',
		'kind', kind,
		'chain', ((host -> 'chain') - 'sessions')
			|| jsonb_build_object('chats', COALESCE(host -> 'chain' -> 'sessions', '[]'::jsonb))
	)
	|| CASE WHEN host ? 'channel'
		THEN jsonb_build_object('channel', host -> 'channel') ELSE '{}'::jsonb END
	|| CASE WHEN kind = 'channel' AND title IS NOT NULL
		THEN jsonb_build_object('title', title) ELSE '{}'::jsonb END
	|| CASE WHEN host ? 'planApproval'
		THEN jsonb_build_object('planApproval', host -> 'planApproval') ELSE '{}'::jsonb END
$$;
--> statement-breakpoint
-- The state of a Chat: the window of the model and the data of the plugins.
-- Learned Session memory goes. The todo list stays.
-- When Items of a Turn that did not end went away, their messages leave the window too.
-- They are at its end, unless the window was made smaller in that Turn. Then the window
-- starts again from all the Items that stay.
CREATE FUNCTION pg_temp.openbot_chat_state(value jsonb, dropped jsonb, kept jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
	context jsonb := value -> 'conversation' -> 'context';
	messages jsonb := COALESCE(value -> 'conversation' -> 'context' -> 'prompt' -> 'content', '[]'::jsonb);
	size integer := jsonb_array_length(COALESCE(value -> 'conversation' -> 'context' -> 'prompt' -> 'content', '[]'::jsonb));
	cut integer := jsonb_array_length(dropped);
BEGIN
	IF cut > 0 THEN
		IF size >= cut AND (
			SELECT jsonb_agg(message ORDER BY place)
			FROM jsonb_array_elements(messages) WITH ORDINALITY AS m(message, place)
			WHERE place > size - cut
		) = dropped THEN
			context := jsonb_set(context, '{prompt,content}', COALESCE((
				SELECT jsonb_agg(message ORDER BY place)
				FROM jsonb_array_elements(messages) WITH ORDINALITY AS m(message, place)
				WHERE place <= size - cut
			), '[]'::jsonb));
		ELSE
			context := jsonb_build_object('_tag', 'Prompt', 'prompt', jsonb_build_object('content', kept));
		END IF;
	END IF;
	-- No Turn runs after this migration.
	RETURN (value - '@openbot-build/openbot/memory')
		|| jsonb_build_object('conversation', jsonb_build_object('context', context, 'closed', true));
END
$$;
--> statement-breakpoint
-- Each Item gets its place in the log of its Chat, from 1. `origin.session` becomes
-- `origin.chat`. Items that a Fork took from another Session now belong to this Chat.
INSERT INTO openbot_chat_items (namespace, chat, seq, id, turn, value)
SELECT
	i.namespace,
	i.chat,
	i.seq,
	i.id,
	i.turn,
	(
		jsonb_build_object('id', i.id, 'content', i.payload -> 'content', 'seq', i.seq)
		|| CASE WHEN jsonb_typeof(i.payload -> 'origin') = 'object'
			THEN jsonb_build_object(
				'origin',
				((i.payload -> 'origin') - 'session') || jsonb_build_object('chat', i.chat)
			)
			ELSE '{}'::jsonb
		END
	)::text
FROM (
	SELECT
		namespace,
		chat,
		id,
		turn,
		payload,
		(row_number() OVER (PARTITION BY namespace, chat ORDER BY place))::integer AS seq
	FROM pg_temp.openbot_kept_items
	WHERE NOT dropped
) i;
--> statement-breakpoint
-- The Turns of a Session and the Turns that a Fork took with it, so every Item finds its
-- Turn. The Turns from the Fork come first, because they are older.
INSERT INTO openbot_chat_turns (namespace, chat, id, position, value)
SELECT
	k.namespace,
	k.id,
	t.turn ->> 'id',
	row_number() OVER (ORDER BY k.namespace, k.id, t.inherited DESC, t.place),
	pg_temp.openbot_chat_turn(t.turn, k.id)::text
FROM pg_temp.openbot_kept_sessions k
CROSS JOIN LATERAL (
	SELECT turn, place, true AS inherited
	FROM jsonb_array_elements(k.body -> 'inheritedTurns') WITH ORDINALITY AS a(turn, place)
	UNION ALL
	SELECT turn, place, false AS inherited
	FROM jsonb_array_elements(k.body -> 'turns') WITH ORDINALITY AS a(turn, place)
) t;
--> statement-breakpoint
SELECT setval(
	pg_get_serial_sequence('openbot_chat_turns', 'position'),
	COALESCE(max(position), 0) + 1,
	false
)
FROM openbot_chat_turns;
--> statement-breakpoint
-- The record of each Chat. The title, the archive flag and the Fork source go.
-- The waiting input becomes the inbox. Input for a Turn that ended waits for the next Turn,
-- and a host action for such a Turn goes.
INSERT INTO openbot_chats (
	namespace, id, body, state, bot, kind, status, turn, revision, inbox_size,
	runner_seen_at, created_at, updated_at
)
SELECT
	k.namespace,
	k.id,
	(
		jsonb_build_object(
			'id', k.id,
			'revision', k.body -> 'revision',
			'settings', k.body -> 'settings',
			'inbox', inbox.entries,
			'seq', items.count,
			'business', ((k.body -> 'business') - '@openbot-build/openbot/session-host')
				|| jsonb_build_object(
					'@openbot-build/openbot/chat-host',
					pg_temp.openbot_chat_host(k.host, k.kind, k.title)
				),
			'createdAt', times.created
		)
		|| CASE WHEN last.turn IS NULL
			THEN '{}'::jsonb ELSE jsonb_build_object('turn', last.turn) END
	)::text,
	pg_temp.openbot_chat_state(k.value, messages.dropped, messages.kept)::text,
	k.host ->> 'bot',
	k.kind,
	COALESCE(last.turn -> 'status' ->> '_tag', 'Idle'),
	last.turn ->> 'id',
	(k.body ->> 'revision')::integer,
	jsonb_array_length(inbox.entries),
	NULL,
	times.created,
	COALESCE(
		floor((last.turn ->> 'completedAt')::numeric)::bigint,
		floor((last.turn ->> 'startedAt')::numeric)::bigint,
		times.created
	)
FROM pg_temp.openbot_kept_sessions k
CROSS JOIN LATERAL (
	SELECT pg_temp.openbot_chat_turn(k.body -> 'turns' -> -1, k.id) AS turn
) last
CROSS JOIN LATERAL (
	SELECT COALESCE(
		jsonb_agg(
			CASE WHEN entry ->> 'kind' = 'action' THEN entry
				ELSE (entry - 'turn') || jsonb_build_object('kind', 'message')
			END
			ORDER BY place
		),
		'[]'::jsonb
	) AS entries
	FROM jsonb_array_elements(k.body -> 'pending') WITH ORDINALITY AS p(entry, place)
	WHERE NOT (entry ->> 'kind' = 'action' AND entry ? 'turn')
) inbox
CROSS JOIN LATERAL (
	SELECT count(*) AS count
	FROM pg_temp.openbot_kept_items i
	WHERE i.namespace = k.namespace AND i.chat = k.id AND NOT i.dropped
) items
CROSS JOIN LATERAL (
	SELECT
		COALESCE(jsonb_agg(m.message ORDER BY i.place, m.place) FILTER (WHERE i.dropped), '[]'::jsonb) AS dropped,
		COALESCE(jsonb_agg(m.message ORDER BY i.place, m.place) FILTER (WHERE NOT i.dropped), '[]'::jsonb) AS kept
	FROM pg_temp.openbot_kept_items i
	CROSS JOIN LATERAL jsonb_array_elements(i.payload -> 'content' -> 'content')
		WITH ORDINALITY AS m(message, place)
	WHERE i.namespace = k.namespace
		AND i.chat = k.id
		AND cardinality(k.unfinished) > 0
) messages
CROSS JOIN LATERAL (
	SELECT COALESCE(
		(
			SELECT floor(min((turn ->> 'startedAt')::numeric))::bigint
			FROM jsonb_array_elements(k.body -> 'turns') AS a(turn)
		),
		(
			SELECT floor(max((turn ->> 'startedAt')::numeric))::bigint
			FROM jsonb_array_elements(k.body -> 'inheritedTurns') AS a(turn)
		),
		(extract(epoch FROM now()) * 1000)::bigint
	) AS created
) times;
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_chat_state(jsonb, jsonb, jsonb);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_chat_host(jsonb, text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_chat_turn(jsonb, text);
--> statement-breakpoint
DROP TABLE pg_temp.openbot_kept_items;
--> statement-breakpoint
DROP TABLE pg_temp.openbot_kept_sessions;
--> statement-breakpoint
DROP TABLE "openbot_timeline_contents";--> statement-breakpoint
DROP TABLE "openbot_session_references";--> statement-breakpoint
DROP TABLE "openbot_timeline_versions";--> statement-breakpoint
ALTER TABLE "openbot_app_invocations" RENAME COLUMN "session" TO "chat";--> statement-breakpoint
ALTER TABLE "openbot_channel_conversations" RENAME COLUMN "session" TO "chat";--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" RENAME COLUMN "session" TO "chat";--> statement-breakpoint
ALTER TABLE "openbot_code_runs" RENAME COLUMN "session" TO "chat";--> statement-breakpoint
ALTER TABLE "openbot_usage_events" RENAME COLUMN "session_id" TO "chat_id";--> statement-breakpoint
ALTER INDEX "openbot_app_invocations_session" RENAME TO "openbot_app_invocations_chat";--> statement-breakpoint
ALTER INDEX "openbot_channel_conversations_session" RENAME TO "openbot_channel_conversations_chat";--> statement-breakpoint
ALTER INDEX "openbot_code_runs_session" RENAME TO "openbot_code_runs_chat";--> statement-breakpoint
CREATE INDEX "openbot_chat_items_turn" ON "openbot_chat_items" ("namespace","chat","turn");--> statement-breakpoint
CREATE INDEX "openbot_chat_turns_order" ON "openbot_chat_turns" ("namespace","chat","position");--> statement-breakpoint
CREATE INDEX "openbot_chats_bot" ON "openbot_chats" ("namespace","bot","kind");--> statement-breakpoint
CREATE INDEX "openbot_chats_waiting" ON "openbot_chats" ("status","inbox_size") WHERE "inbox_size" > 0 OR "status" = 'Running';--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_chats_direct" ON "openbot_chats" ("namespace","bot") WHERE "kind" = 'direct';--> statement-breakpoint
-- Answers of Turns in Sessions that went away are not sent any more.
DELETE FROM openbot_channel_deliveries d
WHERE d.chat IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM openbot_chats c WHERE c.id = d.chat);
--> statement-breakpoint
-- App calls, Code Mode programs and the state of App views are sealed, and each one holds
-- a Session and sometimes a Timeline version. SQL cannot change sealed text, so they go.
-- They are records of old calls. Calls that still waited stop anyway.
DELETE FROM openbot_app_invocations;
--> statement-breakpoint
DELETE FROM openbot_code_runs;
--> statement-breakpoint
DELETE FROM openbot_app_secrets WHERE kind IN ('app-view', 'app-ui-state', 'app-view-action');
--> statement-breakpoint
-- Delegations, waits and memory jobs worked inside Sessions. Their records go.
DELETE FROM openbot_bot_records WHERE kind IN ('delegation', 'wait', 'memory_job');
--> statement-breakpoint
-- `bots.spawn` and `bots.promote` are gone, so Grants and requests for them go.
DELETE FROM openbot_bot_records
WHERE (kind = 'grant' AND body::jsonb -> 'capability' ->> 'action' IN ('bots.spawn', 'bots.promote'))
	OR (kind = 'request' AND body::jsonb -> 'request' -> 'capability' ->> 'action' IN ('bots.spawn', 'bots.promote'));
--> statement-breakpoint
-- A Grant for one Session stays only when its Session became a Chat. Then it lasts in that Chat.
DELETE FROM openbot_bot_records r
WHERE r.kind = 'grant'
	AND r.body::jsonb ->> 'scope' = 'session'
	AND NOT EXISTS (
		SELECT 1 FROM openbot_chats c WHERE c.id = r.body::jsonb ->> 'session'
	);
--> statement-breakpoint
UPDATE openbot_bot_records
SET body = (
	((body::jsonb) - 'session')
	|| CASE WHEN body::jsonb ? 'session'
		THEN jsonb_build_object('chat', body::jsonb -> 'session') ELSE '{}'::jsonb END
	|| CASE WHEN body::jsonb ->> 'scope' = 'session'
		THEN jsonb_build_object('scope', 'chat') ELSE '{}'::jsonb END
)::text
WHERE kind = 'grant' AND (body::jsonb ? 'session' OR body::jsonb ->> 'scope' = 'session');
--> statement-breakpoint
-- A request names a Chat in place of a Session. A request that still waited is cancelled,
-- in the same way as when its work stops.
CREATE FUNCTION pg_temp.openbot_chat_request(body jsonb, stopped_at bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
	request jsonb := body -> 'request';
	chain jsonb := body -> 'chain';
BEGIN
	IF request ? 'session' THEN
		request := (request - 'session') || jsonb_build_object('chat', request -> 'session');
	END IF;
	IF jsonb_typeof(request -> 'app') = 'object' AND request -> 'app' ? 'session' THEN
		request := jsonb_set(
			request,
			'{app}',
			((request -> 'app') - 'session') || jsonb_build_object('chat', request -> 'app' -> 'session')
		);
	END IF;
	IF request -> 'decision' ->> 'scope' = 'session' THEN
		request := jsonb_set(request, '{decision,scope}', '"chat"');
	END IF;
	IF jsonb_typeof(request -> 'endorsements') = 'array' THEN
		request := jsonb_set(request, '{endorsements}', COALESCE((
			SELECT jsonb_agg(
				CASE WHEN entry ->> 'scope' = 'session'
					THEN jsonb_set(entry, '{scope}', '"chat"') ELSE entry END
				ORDER BY place
			)
			FROM jsonb_array_elements(request -> 'endorsements') WITH ORDINALITY AS e(entry, place)
		), '[]'::jsonb));
	END IF;
	IF request ->> 'status' = 'pending' THEN
		request := request || jsonb_build_object(
			'status', 'cancelled',
			'decision', jsonb_build_object(
				'by', jsonb_build_object('_tag', 'Person', 'userId', chain -> 'userId'),
				'reason', 'The work was cancelled before the request was answered.',
				'at', stopped_at
			),
			'revision', (request ->> 'revision')::bigint + 1
		);
	END IF;
	IF chain ? 'sessions' THEN
		chain := (chain - 'sessions') || jsonb_build_object('chats', chain -> 'sessions');
	END IF;
	RETURN body || jsonb_build_object('request', request, 'chain', chain);
END
$$;
--> statement-breakpoint
UPDATE openbot_bot_records
SET
	body = pg_temp.openbot_chat_request(body::jsonb, (extract(epoch FROM now()) * 1000)::bigint)::text,
	status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END
WHERE kind = 'request';
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_chat_request(jsonb, bigint);
--> statement-breakpoint
-- What a Bot confided and what the memory Bot added to a Turn stay only for Sessions that
-- became Chats. Their `owner` key is the Session.
DELETE FROM openbot_bot_records r
WHERE r.kind IN ('confession', 'memory_enrichment', 'memory_cursor')
	AND NOT EXISTS (
		SELECT 1 FROM openbot_chats c
		WHERE c.id = CASE WHEN r.kind = 'memory_cursor' THEN r.scope ELSE r.owner END
	);
--> statement-breakpoint
UPDATE openbot_bot_records
SET body = (((body::jsonb) - 'session') || jsonb_build_object('chat', body::jsonb -> 'session'))::text
WHERE kind IN ('confession', 'memory_enrichment') AND body::jsonb ? 'session';
--> statement-breakpoint
-- The memory Bot kept the IDs of the Items that it read. Now it keeps the place of the last
-- Item that it read in the log of the Chat. Its `scope` key is the Session.
UPDATE openbot_bot_records r
SET body = jsonb_build_object('after', COALESCE((
	SELECT max(i.seq)
	FROM openbot_chats c
	JOIN openbot_chat_items i ON i.namespace = c.namespace AND i.chat = c.id
	WHERE c.id = r.scope
		AND i.id IN (SELECT jsonb_array_elements_text(r.body::jsonb -> 'processed'))
), 0))::text
WHERE r.kind = 'memory_cursor' AND r.body::jsonb ? 'processed';
--> statement-breakpoint
-- There is only one kind of Bot now, so `kind` goes. A Session Bot becomes an archived Bot,
-- and the Bot of its Session owns it. The status key is `active` or `archived`.
UPDATE openbot_bot_records
SET
	body = (
		CASE WHEN body::jsonb -> 'owner' ->> '_tag' = 'Session'
			THEN ((body::jsonb) - 'kind') || jsonb_build_object(
				'owner', jsonb_build_object(
					'_tag', 'Bot',
					'bot', body::jsonb -> 'owner' -> 'bot',
					'userId', body::jsonb -> 'owner' -> 'userId'
				),
				'archived', true
			)
			ELSE (body::jsonb) - 'kind'
		END
	)::text,
	scope = CASE WHEN body::jsonb -> 'owner' ->> '_tag' = 'Session'
		THEN body::jsonb -> 'owner' ->> 'bot' ELSE scope END,
	status = CASE
		WHEN body::jsonb -> 'owner' ->> '_tag' = 'Session' OR status = 'session' THEN 'archived'
		WHEN status = 'persistent' THEN 'active'
		ELSE status
	END
WHERE kind = 'bot'
	AND (
		body::jsonb ? 'kind'
		OR body::jsonb -> 'owner' ->> '_tag' = 'Session'
		OR status IN ('persistent', 'session')
	);
--> statement-breakpoint
-- Bot memory names Chats in place of Sessions: the tag `session:<id>` and the source
-- `{session, item}`.
UPDATE openbot_bot_memory_tags SET tag = 'chat:' || substr(tag, 9) WHERE tag LIKE 'session:%';
--> statement-breakpoint
UPDATE openbot_bot_memories
SET sources = COALESCE((
	SELECT jsonb_agg(
		CASE WHEN source ? 'session'
			THEN (source - 'session') || jsonb_build_object('chat', source -> 'session')
			ELSE source
		END
		ORDER BY place
	)
	FROM jsonb_array_elements(sources::jsonb) WITH ORDINALITY AS s(source, place)
), '[]'::jsonb)::text
WHERE EXISTS (
	SELECT 1 FROM jsonb_array_elements(sources::jsonb) AS a(source) WHERE source ? 'session'
);
--> statement-breakpoint
-- In policies, the permission groups `sessions.read` and `sessions.write` become
-- `chats.read` and `chats.write`, and the resource kind `session` becomes `chat`, as in
-- `openbot.org.{org}.user.{self}.chat`. Only whole JSON strings change, so free text,
-- where JSON escapes each quote, stays the same.
CREATE FUNCTION pg_temp.openbot_chat_words(value text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	result text := value;
	before text;
BEGIN
	IF result IS NULL THEN
		RETURN result;
	END IF;
	result := regexp_replace(result, '(?<!\\)"sessions\.(read|write)"', '"chats.\1"', 'g');
	LOOP
		before := result;
		result := regexp_replace(
			result,
			'(?<!\\)"(openbot\.org(?:\.[^."[:space:]]+)*)\.session((?:\.[^."[:space:]]+)*)"',
			'"\1.chat\2"',
			'g'
		);
		EXIT WHEN result = before;
	END LOOP;
	RETURN result;
END
$$;
--> statement-breakpoint
UPDATE openbot_roles SET policies = pg_temp.openbot_chat_words(policies)
WHERE pg_temp.openbot_chat_words(policies) IS DISTINCT FROM policies;
--> statement-breakpoint
UPDATE openbot_members SET policies = pg_temp.openbot_chat_words(policies)
WHERE pg_temp.openbot_chat_words(policies) IS DISTINCT FROM policies;
--> statement-breakpoint
UPDATE openbot_tokens SET policies = pg_temp.openbot_chat_words(policies)
WHERE pg_temp.openbot_chat_words(policies) IS DISTINCT FROM policies;
--> statement-breakpoint
-- The settings of the platform hold the policy ceiling.
UPDATE openbot_settings SET document = pg_temp.openbot_chat_words(document)
WHERE pg_temp.openbot_chat_words(document) IS DISTINCT FROM document;
--> statement-breakpoint
DROP FUNCTION pg_temp.openbot_chat_words(text);
--> statement-breakpoint
-- Learned Session memory is gone, and so are its switches in the settings of organizations.
UPDATE openbot_settings SET document = ((document::jsonb) - 'memory')::text
WHERE scope_kind = 'organization' AND document::jsonb ? 'memory';
--> statement-breakpoint
-- Usage of learned Session memory keeps its cost, but its source no longer exists.
UPDATE openbot_usage_events SET source = 'other' WHERE source = 'session_memory';

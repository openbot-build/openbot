-- The organization settings lose defaultModel and helperModel. Each use now
-- names its own model: a Session takes the model of its Agent, the judge of
-- Rules takes rulesModel, and Agent memory takes agentMemoryModel.

-- 1. An Agent without a model takes the old defaultModel of its organization.
-- Organizations whose defaultModel is null keep Agents without a model.
UPDATE "openbot_agent_records" AS "agent"
SET "body" = (("agent"."body"::jsonb) || jsonb_build_object('model', ("settings"."document"::jsonb) -> 'defaultModel'))::text
FROM "openbot_settings" AS "settings"
WHERE "agent"."kind" = 'agent'
	AND "settings"."scope_kind" = 'organization'
	AND "settings"."scope_id" = "agent"."organization_id"
	AND ("agent"."body"::jsonb) -> 'model' IS NULL
	AND jsonb_typeof(("settings"."document"::jsonb) -> 'defaultModel') = 'object';
--> statement-breakpoint
-- 2. rulesModel and agentMemoryModel take the old helper model. The helper
-- model was helperModel, or defaultModel when helperModel was null.
-- A missing key gives SQL NULL, and a JSON null gives the JSON value null,
-- so NULLIF turns a JSON null into SQL NULL before COALESCE.
UPDATE "openbot_settings"
SET "document" = (
	(("document"::jsonb) - 'defaultModel' - 'helperModel')
	|| jsonb_build_object(
		'rulesModel',
		COALESCE(
			NULLIF(("document"::jsonb) -> 'helperModel', 'null'::jsonb),
			NULLIF(("document"::jsonb) -> 'defaultModel', 'null'::jsonb),
			'null'::jsonb
		),
		'agentMemoryModel',
		COALESCE(
			NULLIF(("document"::jsonb) -> 'helperModel', 'null'::jsonb),
			NULLIF(("document"::jsonb) -> 'defaultModel', 'null'::jsonb),
			'null'::jsonb
		)
	)
)::text
WHERE "scope_kind" = 'organization';
